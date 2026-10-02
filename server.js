require('dotenv').config();
const express = require('express');
const cors = require('cors');
const neo4j = require('neo4j-driver');
const { randomUUID } = require('crypto');

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
);
const app = express();
app.use(cors(), express.json());

const run = async (query, params = {}) => {
  const session = driver.session({ database: process.env.NEO4J_DATABASE });
  try { return (await session.run(query, params)).records; }
  finally { await session.close(); }
};
const num = v => (neo4j.isInt(v) ? v.toNumber() : v);

// All notes + links (the frontend draws this)
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

// Create a note
app.post('/api/notes', async (req, res) => {
  const { title, body = '' } = req.body;
  const id = randomUUID();
  await run('CREATE (:Note {id:$id, title:$title, body:$body})', { id, title, body });
  res.json({ id, title, body });
});

// Link two notes
app.post('/api/links', async (req, res) => {
  const { from, to, weight = 3 } = req.body;
  await run(`MATCH (a:Note {id:$from}), (b:Note {id:$to})
    MERGE (a)-[r:LINKS_TO]->(b) SET r.weight = $weight`, { from, to, weight });
  res.json({ ok: true });
});

// Shortest path between two notes (returns ordered note ids)
app.get('/api/path', async (req, res) => {
  const { from, to } = req.query;
  const r = await run(`MATCH (a:Note {id:$from}), (b:Note {id:$to}),
    p = shortestPath((a)-[:LINKS_TO*..10]-(b))
    RETURN [x IN nodes(p) | x.title] AS titles, [x IN nodes(p) | x.id] AS ids`, { from, to });
  res.json(r.length ? { ids: r[0].get('ids'), titles: r[0].get('titles') } : { ids: [], titles: [] });
});

// Similar notes (Jaccard on shared neighbors)
app.get('/api/similar/:id', async (req, res) => {
  const r = await run(`MATCH (a:Note {id:$id})-[:LINKS_TO]-(x)-[:LINKS_TO]-(b:Note) WHERE b <> a
    WITH a, b, count(DISTINCT x) AS shared
    MATCH (a)-[:LINKS_TO]-(na) WITH a, b, shared, count(DISTINCT na) AS da
    MATCH (b)-[:LINKS_TO]-(nb) WITH b, shared, da, count(DISTINCT nb) AS db
    RETURN b.id AS id, b.title AS title, toFloat(shared) / (da + db - shared) AS score
    ORDER BY score DESC LIMIT 5`, { id: req.params.id });
  res.json(r.map(x => ({ id: x.get('id'), title: x.get('title'), score: x.get('score') })));
});

// Search: find a start note, then return its linked notes as context
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

// Load sample data once: POST /api/seed
app.post('/api/seed', async (_, res) => {
  await run(`
    CREATE (a:Note {id:'1', title:'Neo4j Basics', body:'Graph database of nodes and relationships'})
    CREATE (b:Note {id:'2', title:'Cypher', body:'Query language for graphs'})
    CREATE (c:Note {id:'3', title:'GraphRAG', body:'Vector search plus graph traversal for LLMs'})
    CREATE (d:Note {id:'4', title:'PostgreSQL', body:'Relational store for users and sessions'})
    CREATE (e:Note {id:'5', title:'S3 Audio Files', body:'Audio and image objects in AWS S3'})
    CREATE (a)-[:LINKS_TO {weight:5}]->(b)
    CREATE (a)-[:LINKS_TO {weight:4}]->(c)
    CREATE (b)-[:LINKS_TO {weight:3}]->(c)
    CREATE (d)-[:LINKS_TO {weight:3}]->(e)
    CREATE (a)-[:LINKS_TO {weight:2}]->(d)`);
  res.json({ ok: true });
});

app.listen(3000, () => console.log('API on http://localhost:3000'));
