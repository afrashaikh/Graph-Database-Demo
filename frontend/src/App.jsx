import React, { useState, useEffect, useRef, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import './App.css';

export default function App() {
  const fgRef = useRef();

  // STATE DECLARATIONS

  // graph state
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [activeNode, setActiveNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState('Loading graph...');

  // add note form state
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [linkTargetId, setLinkTargetId] = useState('');

  // existing node add link state
  const [linkSourceNodeId, setLinkSourceNodeId] = useState('');
  const [linkTargetNodeId, setLinkTargetNodeId] = useState('');
  const [linkWeight, setLinkWeight] = useState(3);

  // pulls graph topology
  const fetchGraph = async () => {
    try {
      setStatus('Fetching graph data...');
      const res = await fetch('/api/graph');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      
      setGraphData(data);
      setStatus(`Loaded ${data.nodes.length} nodes, ${data.links.length} edges`);
    } catch (err) {
      setStatus(`Error loading graph: ${err.message}`);
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

  // search function
  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setStatus(`Searching for "${searchQuery}"...`);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      const match = await res.json();

      if (match && match.id) {

        // find node in existing graph
        const found = graphData.nodes.find(n => n.id === match.id);
        if (found) {
          setActiveNode(found);
          setStatus(`Found node: ${found.title}`);
          // put screen on matched node
          if (fgRef.current && found.x !== undefined) {
            fgRef.current.centerAt(found.x, found.y, 800);
            fgRef.current.zoom(2.5, 800);
          }
        }
      } else {
        setStatus('No matching notes found.');
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
      {/* --- sidebar --- */}
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
            placeholder="Search notes..."
          />
          <button type="submit" className="btn btn-primary">Search</button>
        </form>

        {/* refresh */}
        <button onClick={fetchGraph} className="btn btn-secondary">Refresh Graph</button>

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