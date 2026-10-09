require('dotenv').config(); //loads my Neo4j login
const express = require('express'); //starts an express server
const cors = require('cors');
const neo4j = require('neo4j-driver');
const { randomUUID } = require('crypto');

// arangoDB imports & initialization
const { Database, aql } = require('arangojs');

const arangoDb = new Database({
  url: process.env.ARANGO_URL || 'http://localhost:8529',
  databaseName: process.env.ARANGO_DB || '_system',
  auth: {
    username: process.env.ARANGO_USER || 'root',
    password: process.env.ARANGO_PASSWORD || '',
  },
});

// initialize doc and edge collections for arangoDB if do not exist
const initArango = async () => {
  try {
    const collections = await arangoDb.listCollections();
    const names = collections.map(c => c.name);
    if (!names.includes('notes')) {
      await arangoDb.createCollection('notes');
    }
    if (!names.includes('links')) {
      await arangoDb.createEdgeCollection('links');
    }
  } catch (err) {
    console.error('ARANGODB INITIALIZATION FAILED:', err.message);
  }
};
initArango();

const driver = neo4j.driver( //creates a driver, the connection object
  process.env.NEO4J_URI, //takes address 
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD) //takes username and password
);
const app = express();
app.use(cors(), express.json());

const run = async (query, params = {}) => {
  const session = driver.session({ database: process.env.NEO4J_DATABASE }); //then creates a new session in the database for each query
  try { return (await session.run(query, params)).records; }
  finally { await session.close(); }
};
const num = v => (neo4j.isInt(v) ? v.toNumber() : v);

//all notes and links 
app.get('/api/graph', async (_, res) => {
  const n = await run(`MATCH (n:Note)
    RETURN n.id AS id, n.title AS title, n.body AS body, COUNT { (n)--() } AS degree`);
  const l = await run(`MATCH (a:Note)-[r:LINKS_TO]->(b:Note)
    RETURN a.id AS source, b.id AS target, r.weight AS weight`);
  res.json({
    nodes: n.map(r => ({ id: r.get('id'), title: r.get('title'), body: r.get('body'), degree: num(r.get('degree')) })),
    links: l.map(r => ({ source: r.get('source'), target: r.get('target'), weight: num(r.get('weight')) })),
  });
});

//creates a note
app.post('/api/notes', async (req, res) => {
  const { title, body = '' } = req.body;
  const id = randomUUID();
  await run('CREATE (:Note {id:$id, title:$title, body:$body})', { id, title, body });
  res.json({ id, title, body });
});

//links two notes
app.post('/api/links', async (req, res) => {
  const { from, to, weight = 3 } = req.body;
  await run(`MATCH (a:Note {id:$from}), (b:Note {id:$to})
    MERGE (a)-[r:LINKS_TO]->(b) SET r.weight = $weight`, { from, to, weight });
  res.json({ ok: true });
});

//shortest path between two notes
app.get('/api/path', async (req, res) => {
  const { from, to } = req.query;
  const r = await run(`MATCH (a:Note {id:$from}), (b:Note {id:$to}),
    p = shortestPath((a)-[:LINKS_TO*..10]-(b))
    RETURN [x IN nodes(p) | x.title] AS titles, [x IN nodes(p) | x.id] AS ids`, { from, to });
  res.json(r.length ? { ids: r[0].get('ids'), titles: r[0].get('titles') } : { ids: [], titles: [] });
});

//similar notes matching
app.get('/api/similar/:id', async (req, res) => {
  const r = await run(`MATCH (a:Note {id:$id})-[:LINKS_TO]-(x)-[:LINKS_TO]-(b:Note) WHERE b <> a
    WITH a, b, count(DISTINCT x) AS shared
    MATCH (a)-[:LINKS_TO]-(na) WITH a, b, shared, count(DISTINCT na) AS da
    MATCH (b)-[:LINKS_TO]-(nb) WITH b, shared, da, count(DISTINCT nb) AS db
    RETURN b.id AS id, b.title AS title, toFloat(shared) / (da + db - shared) AS score
    ORDER BY score DESC LIMIT 5`, { id: req.params.id });
  res.json(r.map(x => ({ id: x.get('id'), title: x.get('title'), score: x.get('score') })));
});

//searching: find a start note, then return its linked notes as context
app.get('/api/search', async (req, res) => {
  const r = await run(`MATCH (n:Note)
    WHERE toLower(n.title) CONTAINS toLower($q) OR toLower(n.body) CONTAINS toLower($q)
    WITH n LIMIT 1
    OPTIONAL MATCH (n)-[r:LINKS_TO]-(c:Note)
    RETURN n.id AS id, n.title AS title,
      collect({id: c.id, title: c.title, weight: r.weight}) AS context`, { q: req.query.q || '' });
  if (!r.length) return res.json(null);
  res.json({
    id: r[0].get('id'), title: r[0].get('title'),
    context: r[0].get('context').filter(c => c.id),
  });
});

//loads sample data once
//POST /api/seed
//test
app.post('/api/seed', async (_, res) => {
  await run(`
    CREATE (a:Note {id:'1', title:'Neo4j Basics', body:'Graph database of nodes and relationships'})
    CREATE (b:Note {id:'2', title:'Cypher', body:'Query language for graphs'})
    CREATE (c:Note {id:'3', title:'GraphRAG', body:'Vector search plus graph traversal'})
    CREATE (d:Note {id:'4', title:'PostgreSQL', body:'Relational store for users and sessions'})
    CREATE (e:Note {id:'5', title:'S3 Audio Files', body:'Audio and image objects'})
    CREATE (a)-[:LINKS_TO {weight:5}]->(b)
    CREATE (a)-[:LINKS_TO {weight:4}]->(c)
    CREATE (b)-[:LINKS_TO {weight:3}]->(c)
    CREATE (d)-[:LINKS_TO {weight:3}]->(e)
    CREATE (a)-[:LINKS_TO {weight:2}]->(d)`);
  res.json({ ok: true });
});

// ICE'S ARANGO_DB BELOW!!!

// fetch notes
app.get('/api/arango/graph', async (_, res) => {
  try {
    const nodesCursor = await arangoDb.query(aql`
      FOR n IN notes
        LET degree = LENGTH(FOR v IN 1..1 ANY n links RETURN 1)
        RETURN { id: n._key, title: n.title, body: n.body, degree: degree }
    `);
    const linksCursor = await arangoDb.query(aql`
      FOR l IN links
        RETURN { source: PARSE_IDENTIFIER(l._from).key, target: PARSE_IDENTIFIER(l._to).key, weight: l.weight }
    `);
    const [nodes, links] = await Promise.all([nodesCursor.all(), linksCursor.all()]);
    res.json({ nodes, links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// create note
app.post('/api/arango/notes', async (req, res) => {
  const { title, body = '' } = req.body;
  const id = randomUUID();
  try {
    await arangoDb.collection('notes').save({ _key: id, title, body });
    res.json({ id, title, body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// note linking
app.post('/api/arango/links', async (req, res) => {
  const { from, to, weight = 3 } = req.body;
  try {
    const edgeColl = arangoDb.collection('links');
    const existing = await arangoDb.query(aql`
      FOR l IN links
        FILTER l._from == ${`notes/${from}`} AND l._to == ${`notes/${to}`}
        LIMIT 1
        RETURN l
    `);
    const match = await existing.next();
    if (match) {
      await edgeColl.update(match._key, { weight });
    } else {
      await edgeColl.save({
        _from: `notes/${from}`,
        _to: `notes/${to}`,
        weight: Number(weight),
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// shortest path
app.get('/api/arango/path', async (req, res) => {
  const { from, to } = req.query;
  try {
    const cursor = await arangoDb.query(aql`
      LET p = (
        FOR v IN ANY SHORTEST_PATH
          ${`notes/${from}`} TO ${`notes/${to}`}
          links
          RETURN { id: v._key, title: v.title }
      )
      RETURN {
        ids: p[*].id,
        titles: p[*].title
      }
    `);
    const result = await cursor.next();
    res.json(result && result.ids.length ? result : { ids: [], titles: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// jaccard similarity matching
app.get('/api/arango/similar/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const cursor = await arangoDb.query(aql`
      LET startNode = DOCUMENT('notes', ${id})
      LET targetNeighbors = (FOR n IN 1..1 ANY startNode links RETURN DISTINCT n._key)
      LET da = LENGTH(targetNeighbors)
      FOR candidate IN notes
        FILTER candidate._key != ${id}
        LET candNeighbors = (FOR cn IN 1..1 ANY candidate links RETURN DISTINCT cn._key)
        LET db = LENGTH(candNeighbors)
        LET shared = LENGTH(INTERSECTION(targetNeighbors, candNeighbors))
        FILTER shared > 0
        LET score = shared / (da + db - shared)
        SORT score DESC
        LIMIT 5
        RETURN { id: candidate._key, title: candidate.title, score: score }
    `);
    const results = await cursor.all();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// search note w/ adjacent link context
app.get('/api/arango/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  try {
    const cursor = await arangoDb.query(aql`
      FOR n IN notes
        FILTER CONTAINS(LOWER(n.title), ${q}) OR CONTAINS(LOWER(n.body), ${q})
        LIMIT 1
        LET context = (
          FOR v, e IN 1..1 ANY n links
            RETURN { id: v._key, title: v.title, weight: e.weight }
        )
        RETURN { id: n._key, title: n.title, context: context }
    `);
    const result = await cursor.next();
    res.json(result || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// seed arangoDB
app.post('/api/arango/seed', async (_, res) => {
  try {
    await arangoDb.query(aql`
      LET sampleNotes = [
        { _key: '1', title: 'Neo4j Basics', body: 'Graph database of nodes and relationships' },
        { _key: '2', title: 'Cypher', body: 'Query language for graphs' },
        { _key: '3', title: 'GraphRAG', body: 'Vector search plus graph traversal' },
        { _key: '4', title: 'PostgreSQL', body: 'Relational store for users and sessions' },
        { _key: '5', title: 'S3 Audio Files', body: 'Audio and image objects' }
      ]
      FOR doc IN sampleNotes
        UPSERT { _key: doc._key }
        INSERT doc
        UPDATE doc IN notes
    `);

    await arangoDb.query(aql`
      LET sampleLinks = [
        { _from: 'notes/1', _to: 'notes/2', weight: 5 },
        { _from: 'notes/1', _to: 'notes/3', weight: 4 },
        { _from: 'notes/2', _to: 'notes/3', weight: 3 },
        { _from: 'notes/4', _to: 'notes/5', weight: 3 },
        { _from: 'notes/1', _to: 'notes/4', weight: 2 }
      ]
      FOR edge IN sampleLinks
        UPSERT { _from: edge._from, _to: edge._to }
        INSERT edge
        UPDATE { weight: edge.weight } IN links
    `);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('API on http://localhost:3000'));
