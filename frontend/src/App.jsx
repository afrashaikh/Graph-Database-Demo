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
  const [status, setStatus] = useState('Loading graph...');

  // vector embedding state
  const [embeddings, setEmbeddings] = useState({});
  const [rankedResults, setRankedResults] = useState([]);

  // add note form state
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [linkTargetId, setLinkTargetId] = useState('');

  // existing node add link state
  const [linkSourceNodeId, setLinkSourceNodeId] = useState('');
  const [linkTargetNodeId, setLinkTargetNodeId] = useState('');
  const [linkWeight, setLinkWeight] = useState(3);

  // pulls graph topology and embeds nodes
  const fetchGraph = async () => {
    try {
      setStatus('Fetching graph data...');
      const res = await fetch('/api/graph');
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

  // load graph
  useEffect(() => {
    fetchGraph();
  }, []);


  // FORM HANDLERS


  // add new node to db
  const handleCreateNode = async (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    try {
      setStatus('Creating node...');
      
      // create note title and body
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, body: newBody }),
      });
      const created = await res.json();

      // create edge if prompted to link
      if (linkTargetId) {
        setStatus('Linking note...');
        await fetch('/api/links', {
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
      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: linkSourceNodeId,
          to: linkTargetNodeId,
          weight: Number(linkWeight) || 3,
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

    if (Object.keys(embeddings).length === 0) {
      setStatus('Embeddings still generating, please wait...');
      return;
    }

    try {
      setStatus(`Searching for "${query}"...`);
      const queryVec = await embedText(query);

      // rank nodes by similarity
      const scored = graphData.nodes.map(n => ({
        ...n,
        similarity: cosineSimilarity(queryVec, embeddings[n.id] || [])
      }));

      scored.sort((a, b) => b.similarity - a.similarity);
      setRankedResults(scored);

      const best = scored[0];
      if (best && best.similarity > 0.15) {
        setActiveNode(best);
        setStatus(`Best match: "${best.title}" (${(best.similarity * 100).toFixed(1)}%)`);

        // put screen on matched node
        if (fgRef.current && best.x !== undefined) {
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

  return (
    <div className="app-container">
      {/* sidebar */}
      <aside className="sidebar">
        <h2 className="sidebar-title">Graph Explorer</h2>
        <div className="status-badge">Status: {status}</div>

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
          <select
            className="input-field"
            value={linkTargetId}
            onChange={(e) => setLinkTargetId(e.target.value)}
          >
            <option value="">Link to existing note (optional)...</option>
            {graphData.nodes.map(n => (
              <option key={n.id} value={n.id}>{n.title}</option>
            ))}
          </select>
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