import React, { useState, useEffect, useRef, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { embedText, cosineSimilarity } from './embedding';
import './App.css';

export default function App() {
  const fgRef = useRef();

  // STATE DECLARATIONS

  // graph state
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [activeNode, setActiveNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [backend, setBackend] = useState("arango");
  const [status, setStatus] = useState('Loading graph...');

  // vector embedding state
  const [embeddings, setEmbeddings] = useState({});
  const [rankedResults, setRankedResults] = useState([]);

  // add note form state
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [linkTargetId, setLinkTargetId] = useState('');

  // add new note link state
  const [linkType, setLinkType] = useState('RELATES_TO');
  const [linkDescription, setLinkDescription] = useState('');

  // existing node add link state
  const [linkSourceNodeId, setLinkSourceNodeId] = useState('');
  const [linkTargetNodeId, setLinkTargetNodeId] = useState('');
  const [linkWeight, setLinkWeight] = useState(3);
  
  // GraphRAG resutls
  const [graphRagContext, setGraphRagContext] = useState('');
  const [graphRagAnchors, setGraphRagAnchors] = useState([]);
  const [graphRagAnswer, setGraphRagAnswer] = useState('');

  // pulls graph topology and embeds nodes depending on active backend
  const fetchGraph = async () => {
    try {
      setStatus(`Fetching graph from ${backend === 'arango' ? 'ArangoDB' : 'Neo4j'}...`);
      const url = backend === 'arango' ? '/api/arango/graph' : '/api/graph';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      
      setGraphData(data);
      setStatus('Indexing embeddings...');
      await indexNodeVectors(data.nodes);
    } catch (err) {
      setStatus(`Error loading graph: ${err.message}`);
    }
  };

  // calculates vector embeddings for all nodes
  const indexNodeVectors = async (nodes) => {
    try {
      const vectorMap = {};
      for (const node of nodes) {
        const textToEmbed = `${node.title}: ${node.body || ''}`;
        vectorMap[node.id] = await embedText(textToEmbed);
      }
      setEmbeddings(vectorMap);
      setStatus(`Ready (${nodes.length} nodes embedded)`);
    } catch (err) {
      setStatus(`Embedding indexing error: ${err.message}`);
    }
  };

  // reload graph whenever active backend changes
  useEffect(() => {
    fetchGraph();
  }, [backend]);


  // FORM HANDLERS


  // add new node to db
  const handleCreateNode = async (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    try {
      setStatus('Creating node...');
      
      // Generate embedding vector so ArangoDB can store and query it
      let embedding = null;
      try {
        embedding = await embedText(`${newTitle}: ${newBody}`);
      } catch (embErr) {
        console.warn('Embedding calculation failed:', embErr);
      }

      const noteUrl = backend === 'arango' ? '/api/arango/notes' : '/api/notes';
      const res = await fetch(noteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, body: newBody, embedding }),
      });
      const created = await res.json();

      // create edge if prompted to link
      if (linkTargetId) {
        setStatus('Linking note...');
        const linkUrl = backend === 'arango' ? '/api/arango/links' : '/api/links';
        await fetch(linkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: created.id, to: linkTargetId, weight: 3 }),
        });
      }

      // render new node (reset graph)
      setNewTitle('');
      setNewBody('');
      setLinkTargetId('');
      setStatus(`Created note: "${created.title}"`);
      await fetchGraph();
    } catch (err) {
      setStatus(`Failed to create node: ${err.message}`);
    }
  };

  // connect existing nodes
  const handleConnectExisting = async (e) => {
    e.preventDefault();
    if (!linkSourceNodeId || !linkTargetNodeId || linkSourceNodeId === linkTargetNodeId) return;

    try {
      setStatus('Creating relationship between nodes...');
      const linkUrl = backend === 'arango' ? '/api/arango/links' : '/api/links';
      const res = await fetch(linkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: linkSourceNodeId,
          to: linkTargetNodeId,
          weight: Number(linkWeight) || 3,
          type: linkType || 'RELATES_TO',
          description: linkDescription || ''
        }),
      });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);

      setLinkSourceNodeId('');
      setLinkTargetNodeId('');
      setStatus('Successfully linked notes!');
      await fetchGraph();
    } catch (err) {
      setStatus(`Failed to link nodes: ${err.message}`);
    }
  };

  // semantic search using cosine similarity
  const handleSearch = async (e) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    try {
      setStatus(`Searching for "${query}"...`);
      const queryVec = await embedText(query);

      let scored = [];

      if (backend === 'arango') {
        // ARANGODB: Hybrid Search (Vector + Lexical + Centrality)
        const res = await fetch('/api/arango/semantic-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, queryVec }),
        });
        if (!res.ok) throw new Error(`Search failed: ${res.statusText}`);
        const hits = await res.json();

        // preserve canvas coordinates (x, y) so ForceGraph zoom & highlight work
        scored = hits.map(hit => {
          const matchedGraphNode = graphData.nodes.find(n => n.id === hit.id);
          return {
            ...hit,
            x: matchedGraphNode?.x,
            y: matchedGraphNode?.y,
          };
        });
      } else {
        //  NEO4J: Client-side cosine similarity 
        if (Object.keys(embeddings).length === 0) {
          setStatus('Embeddings still generating, please wait...');
          return;
        }

        scored = graphData.nodes.map(n => ({
          ...n,
          similarity: cosineSimilarity(queryVec, embeddings[n.id] || [])
        }));
        scored.sort((a, b) => b.similarity - a.similarity);
      }

      setRankedResults(scored);
      

      const best = scored[0];
      if (best && best.similarity > 0.15) {
        setActiveNode(best);
        setStatus(
          `Best match (${backend === 'arango' ? 'Hybrid' : 'Cosine'}): "${best.title}" (${(best.similarity * 100).toFixed(1)}%)`
        );

        // pan and center camera on best match
        if (fgRef.current && best.x !== undefined && best.y !== undefined) {
          fgRef.current.centerAt(best.x, best.y, 800);
          fgRef.current.zoom(2.5, 800);
        }
      } else {
        setActiveNode(null);
        setStatus(`No relevant match found for "${query}".`);
      }
    } catch (err) {
      setStatus(`Search failed: ${err.message}`);
    }
  };

  // HYBRID GRAPHRAG
  const handleGraphRagSearch = async (e) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    try {
      setStatus(`Executing Hybrid GraphRAG for "${query}"...`);
      const queryVec = await embedText(query);

      const res = await fetch('/api/arango/graphrag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, queryVec, maxAnchors: 2, maxHops: 1 }),
      });

      if (!res.ok) throw new Error(`GraphRAG failed: ${res.statusText}`);
      const data = await res.json();

      setGraphRagAnchors(data.anchors);
      setGraphRagContext(data.formattedContext);
      setGraphRagAnswer(data.answer); 

      // focus graph camera on the primary anchor node
      if (data.anchors.length > 0) {
        const topAnchor = graphData.nodes.find(n => n.id === data.anchors[0].anchorId);
        if (topAnchor && fgRef.current) {
          setActiveNode(topAnchor);
          fgRef.current.centerAt(topAnchor.x, topAnchor.y, 800);
          fgRef.current.zoom(2.5, 800);
        }
      }
      setStatus(`GraphRAG retrieved ${data.anchors.length} anchor context clusters.`);
    } catch (err) {
      setStatus(`GraphRAG error: ${err.message}`);
    }
  };


  // GRAPH TRAVERSAL


  // build 1-hop neighborhood
  const neighborIds = useMemo(() => {
    if (!activeNode) return new Set();
    const set = new Set([activeNode.id]);
    
    graphData.links.forEach(l => {
      const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
      const targetId = typeof l.target === 'object' ? l.target.id : l.target;

      if (sourceId === activeNode.id) set.add(targetId);
      if (targetId === activeNode.id) set.add(sourceId);
    });

    return set;
  }, [activeNode, graphData.links]);


  // RENDERING

  return (
    <div className="app-container">
      {/* sidebar */}
      <aside className="sidebar">
        <h2 className="sidebar-title">Graph Explorer</h2>
        <div className="status-badge">Status: {status}</div>

        {/* DATABASE BACKEND SWITCHER */}
        <div className="form-group" style={{ marginBottom: '12px' }}>
          <span className="form-label" style={{ fontWeight: 600, color: '#38bdf8' }}>Active Database</span>
          <select
            className="input-field"
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
          >
            <option value="neo4j">Neo4j (Cypher)</option>
            <option value="arango">ArangoDB (AQL)</option>
          </select>
        </div>

        {/* node search */}
        <form onSubmit={handleSearch} className="form-group">
          <input
            type="text"
            className="input-field"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search. . ."
          />
          <button type="submit" className="btn btn-primary">Semantic Search</button>
        </form>

        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
          <button 
            type="button" 
            onClick={handleGraphRagSearch} 
            className="btn btn-success" 
            style={{ flex: 1 }}
          >
            GraphRAG Search
          </button>
        </div>

        {/* GraphRAG answer */}
        {graphRagAnswer && (
          <div style={{
            marginTop: '12px',
            padding: '10px',
            backgroundColor: '#0f172a',
            borderRadius: '6px',
            border: '1px solid #10b981'
          }}>
            <span style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: 600 }}>
              Answer:
            </span>
            <p style={{ fontSize: '0.85rem', color: '#f8fafc', marginTop: '6px', lineHeight: 1.4 }}>
              {graphRagAnswer}
            </p>
          </div>
        )}

        {/* refresh */}
        <button onClick={fetchGraph} className="btn btn-secondary">Refresh Graph</button>

        {/* top semantic matches */}
        {rankedResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 600 }}>TOP MATCHES:</span>
            {rankedResults.slice(0, 3).map(hit => (
              <div
                key={hit.id}
                onClick={() => {
                  setActiveNode(hit);
                  if (fgRef.current && hit.x !== undefined) fgRef.current.centerAt(hit.x, hit.y, 600);
                }}
                style={{
                  padding: '6px 10px',
                  borderRadius: '4px',
                  background: activeNode?.id === hit.id ? '#1e3a8a' : '#1e293b',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  border: '1px solid #334155'
                }}
              >
                <span>{hit.title}</span>
                <span style={{ color: '#38bdf8' }}>{(hit.similarity * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        )}

        <hr className="divider" />

        {/* add/link form */}
        <form onSubmit={handleCreateNode} className="form-group">
          <span className="form-label">Add New Note</span>
          <input
            type="text"
            className="input-field"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Note title (required)"
            required
          />
          <textarea
            className="input-field textarea-field"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="Note body / details..."
            rows={2}
          />
          {/* populates dropdown w/ existing nodes */}
          <button type="submit" className="btn btn-success">+ Create Note</button>
        </form>

        <hr className="divider" />

        {/* link existing nodes */}
        <form onSubmit={handleConnectExisting} className="form-group">
          <span className="form-label">Connect Existing Notes</span>
          <select
            className="input-field"
            value={linkSourceNodeId}
            onChange={(e) => setLinkSourceNodeId(e.target.value)}
            required
          >
            <option value="">From Note...</option>
            {graphData.nodes.map(n => (
              <option key={`src-${n.id}`} value={n.id}>{n.title}</option>
            ))}
          </select>

          <select
            className="input-field"
            value={linkTargetNodeId}
            onChange={(e) => setLinkTargetNodeId(e.target.value)}
            required
          >
            <option value="">To Note...</option>
            {graphData.nodes
              .filter(n => n.id !== linkSourceNodeId)
              .map(n => (
                <option key={`tgt-${n.id}`} value={n.id}>{n.title}</option>
              ))}
          </select>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Weight:</span>
            <input
              type="number"
              min="1"
              max="10"
              className="input-field"
              style={{ width: '60px' }}
              value={linkWeight}
              onChange={(e) => setLinkWeight(e.target.value)}
            />
          </div>

          <input
            type="text"
            className="input-field"
            placeholder="Relation (e.g., IMPLEMENTS, DEPENDS_ON)"
            value={linkType}
            onChange={(e) => setLinkType(e.target.value)}
          />
          <input
            type="text"
            className="input-field"
            placeholder="Relationship context / description..."
            value={linkDescription}
            onChange={(e) => setLinkDescription(e.target.value)}
          />

          <button type="submit" className="btn btn-primary">Connect Nodes</button>
        </form>

        <hr className="divider" />

        {/* details selected node */}
        {activeNode && (
          <div className="node-card">
            <h4 className="node-card-title">{activeNode.title}</h4>
            <p className="node-card-body">{activeNode.body || 'No description provided.'}</p>
            <div className="node-card-meta">Connected Links: {activeNode.degree}</div>
          </div>
        )}
      </aside>

      {/* canvas */}
      <main className="canvas-container">
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          nodeId="id"
          // displays tooltip upon node hover
          nodeLabel={node => `${node.title} (${node.degree} links)`}
          nodeColor={node => {
            if (activeNode?.id === node.id) return '#ef4444'; // color means selected
            if (neighborIds.has(node.id)) return '#f59e0b'; // color means neighbor
            return '#3b82f6'; // color means unselected
          }}
          nodeRelSize={7}
          linkColor={() => '#475569'}
          linkWidth={link => (link.weight ? Math.sqrt(link.weight) : 1)}
          onNodeClick={(node) => {
            setActiveNode(node);
            if (fgRef.current) fgRef.current.centerAt(node.x, node.y, 600);
          }}
        />
      </main>
    </div>
  );
}