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
  try {
    const session = driver.session({ database: process.env.NEO4J_DATABASE });
    try {
      return (await session.run(query, params)).records;
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error('Neo4j Query Error:', err.message);
    throw err;
  }
};
const num = v => (neo4j.isInt(v) ? v.toNumber() : v);

//all notes and links 
app.get('/api/graph', async (_, res) => {
  try {
    const n = await run(`MATCH (n:Note)
      RETURN n.id AS id, n.title AS title, n.body AS body, COUNT { (n)--() } AS degree`);
    const l = await run(`MATCH (a:Note)-[r:LINKS_TO]->(b:Note)
      RETURN a.id AS source, b.id AS target, r.weight AS weight`);
    res.json({
      nodes: n.map(r => ({ id: r.get('id'), title: r.get('title'), body: r.get('body'), degree: num(r.get('degree')) })),
      links: l.map(r => ({ source: r.get('source'), target: r.get('target'), weight: num(r.get('weight')) })),
    });
  } catch (err) {
    res.status(500).json({ error: `Neo4j unavailable: ${err.message}` });
  }
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

app.post('/api/arango/semantic-search', async (req, res) => {
  const { query = '', queryVec = [] } = req.body;
  try {
    const cursor = await arangoDb.query(aql`
      LET queryVec = ${queryVec}
      LET queryText = LOWER(${query})
      LET qLen = LENGTH(queryVec)

      FOR doc IN notes
        // In-line Cosine Similarity calculation
        LET hasEmbedding = IS_ARRAY(doc.embedding) AND LENGTH(doc.embedding) == qLen AND qLen > 0
        LET dotProduct = hasEmbedding ? SUM(FOR i IN 0..(qLen - 1) RETURN doc.embedding[i] * queryVec[i]) : 0
        LET magDoc = hasEmbedding ? SQRT(SUM(FOR i IN 0..(qLen - 1) RETURN doc.embedding[i] * doc.embedding[i])) : 0
        LET magQuery = hasEmbedding ? SQRT(SUM(FOR i IN 0..(qLen - 1) RETURN queryVec[i] * queryVec[i])) : 0
        
        LET rawCosine = (hasEmbedding AND magDoc > 0 AND magQuery > 0)
          ? (dotProduct / (magDoc * magQuery))
          : 0
        LET vectorScore = (rawCosine + 1) / 2

        // Lexical Substring Precision
        LET titleMatch = CONTAINS(LOWER(doc.title), queryText) ? 1.0 : 0.0
        LET bodyMatch = CONTAINS(LOWER(doc.body || ''), queryText) ? 0.5 : 0.0
        LET lexicalScore = MAX([titleMatch, bodyMatch])

        // Graph Degree Centrality
        LET degree = LENGTH(FOR v IN 1..1 ANY doc links RETURN 1)
        LET degreeBoost = LOG(1 + degree) * 0.05

        // Combined Ranking Score
        LET finalScore = (vectorScore * 0.65) + (lexicalScore * 0.25) + degreeBoost

        SORT finalScore DESC
        LIMIT 10
        RETURN {
          id: doc._key,
          title: doc.title,
          body: doc.body,
          degree: degree,
          similarity: finalScore,
          vectorScore: vectorScore,
          lexicalScore: lexicalScore
        }
    `);
    const results = await cursor.all();
    res.json(results);
  } catch (err) {
    console.error('Semantic Search Error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
        RETURN { 
          source: PARSE_IDENTIFIER(l._from).key, 
          target: PARSE_IDENTIFIER(l._to).key, 
          weight: l.weight,
          type: l.type || 'RELATES_TO',
          description: l.description || ''
        }
    `);
    const [nodes, links] = await Promise.all([nodesCursor.all(), linksCursor.all()]);
    res.json({ nodes, links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// create note
app.post('/api/arango/notes', async (req, res) => {
  const { title, body = '', embedding = null } = req.body;
  const id = randomUUID();
  try {
    // Save note including its vector array (if provided)
    await arangoDb.collection('notes').save({ _key: id, title, body, embedding });
    res.json({ id, title, body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// note linking
app.post('/api/arango/links', async (req, res) => {
  const { from, to, weight = 3, type = 'RELATES_TO', description = '' } = req.body;
  try {
    const edgeColl = arangoDb.collection('links');
    const existing = await arangoDb.query(aql`
      FOR l IN links
        FILTER l._from == ${`notes/${from}`} AND l._to == ${`notes/${to}`}
        LIMIT 1
        RETURN l
    `);
    const match = await existing.next();
    
    const edgeData = {
      _from: `notes/${from}`,
      _to: `notes/${to}`,
      weight: Number(weight) || 3,
      type: type.trim().toUpperCase(),
      description: description.trim(),
    };

    if (match) {
      await edgeColl.update(match._key, {
        weight: edgeData.weight,
        type: edgeData.type,
        description: edgeData.description,
      });
    } else {
      await edgeColl.save(edgeData);
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

// HYBRID GRAPHRAG!!!!
// executes hybrid search (Vector + Lexical) -> subgraph expansion (Edges & Neighbors)
app.post('/api/arango/graphrag', async (req, res) => {
  const { query = '', queryVec = [], maxAnchors = 2, maxHops = 1 } = req.body;

  try {
    const cursor = await arangoDb.query(aql`
      LET queryVec = ${queryVec}
      LET queryText = LOWER(${query})
      LET qLen = LENGTH(queryVec)

      // Hybrid Retrieval to find top anchor nodes
      LET scoredAnchors = (
        FOR doc IN notes
          // Vector Cosine Similarity
          LET hasEmbedding = IS_ARRAY(doc.embedding) AND LENGTH(doc.embedding) == qLen AND qLen > 0
          LET dotProduct = hasEmbedding ? SUM(FOR i IN 0..(qLen - 1) RETURN doc.embedding[i] * queryVec[i]) : 0
          LET magDoc = hasEmbedding ? SQRT(SUM(FOR i IN 0..(qLen - 1) RETURN doc.embedding[i] * doc.embedding[i])) : 0
          LET magQuery = hasEmbedding ? SQRT(SUM(FOR i IN 0..(qLen - 1) RETURN queryVec[i] * queryVec[i])) : 0
          LET rawCosine = (hasEmbedding AND magDoc > 0 AND magQuery > 0)
            ? (dotProduct / (magDoc * magQuery))
            : 0
          LET vectorScore = (rawCosine + 1) / 2

          // Lexical Keyword Matching
          LET titleMatch = CONTAINS(LOWER(doc.title), queryText) ? 1.0 : 0.0
          LET bodyMatch = CONTAINS(LOWER(doc.body || ''), queryText) ? 0.5 : 0.0
          LET lexicalScore = MAX([titleMatch, bodyMatch])

          // Centrality Authority Boost
          LET degree = LENGTH(FOR v IN 1..1 ANY doc links RETURN 1)
          LET degreeBoost = LOG(1 + degree) * 0.05

          LET hybridScore = (vectorScore * 0.75) + (lexicalScore * 0.15) + degreeBoost

          SORT hybridScore DESC
          LIMIT ${maxAnchors}
          RETURN {
            node: doc,
            hybridScore: hybridScore,
            vectorScore: vectorScore,
            lexicalScore: lexicalScore
          }
      )

      // Knowledge Graph Subgraph Expansion
      LET expandedContext = (
        FOR anchor IN scoredAnchors
          LET startNode = anchor.node
          LET neighbors = (
            FOR v, e IN 1..${maxHops} ANY startNode links
              RETURN {
                targetId: v._key,
                targetTitle: v.title,
                targetBody: v.body,
                relationType: e.type || 'RELATES_TO',
                relationDescription: e.description || '',
                weight: e.weight || 1
              }
          )
          RETURN {
            anchorId: startNode._key,
            anchorTitle: startNode.title,
            anchorBody: startNode.body,
            scores: {
              hybrid: anchor.hybridScore,
              vector: anchor.vectorScore,
              lexical: anchor.lexicalScore
            },
            relationships: neighbors
          }
      )

      RETURN expandedContext
    `);

    const contextData = await cursor.next();

    // format into LLM-ready context assembly
    const contextAssembly = (contextData || []).map((entry, idx) => {
      const relLines = entry.relationships.map(
        r => `   ↳ [${r.relationType}] -> "${r.targetTitle}" (${r.relationDescription || 'Connected note'})`
      );
      return [
        `[Document ${idx + 1}] Title: ${entry.anchorTitle}`,
        `Content: ${entry.anchorBody}`,
        relLines.length > 0 ? `Graph Relationships:\n${relLines.join('\n')}` : `Graph Relationships: None`,
      ].join('\n');
    }).join('\n\n---\n\n');

    const prompt = `You are a knowledge graph assistant. The relationships define how two entities are related and are not entites themselves. Use ONLY the provided Graph Context to answer the question concisely and accurately in a succint manner. You do not need to explain the process of finding the answer. If the context does not contain the answer or you are unsure, say "I don't have enough information." Always write in human sentences. Do not explain the graph context or the reasoning process unless asked why. If multiple answers exist, include a reasonable amount of them as long as it is accurate. If the answer is not in the context, do not hallucinate.

    Graph Context:
    ${contextAssembly}

    Question: ${query}
    Answer:`;

    let generatedAnswer = '';

    try {
      const ollamaRes = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3.2:1b',
          prompt: prompt,
          stream: false,
        }),
      });

      if (ollamaRes.ok) {
        const ollamaData = await ollamaRes.json();
        generatedAnswer = ollamaData.response.trim();
      } else {
        generatedAnswer = 'Failed to generate answer from local LLM.';
      }
    } catch (llmErr) {
      console.warn('Ollama unreachable, returning raw context instead:', llmErr.message);
      generatedAnswer = 'Local LLM offline. Run Ollama on port 11434 to enable text generation.';
    }

    res.json({
      answer: generatedAnswer || 'No answer generated yet.',
      anchors: contextData,
      formattedContext: contextAssembly
    });
  } catch (err) {
    console.error('GraphRAG Error:', err.message);
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
