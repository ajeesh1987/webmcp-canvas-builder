import React, { useState, useEffect, useRef } from "react";
import "./App.css";

// Keep in sync with the CSS custom properties in App.css —
// canvas drawing can't read CSS vars directly.
const COLORS = {
  bg: "#fafbfc",
  gridDot: "rgba(20, 22, 30, 0.08)",
  cardFill: "#ffffff",
  cardBorder: "rgba(20, 22, 30, 0.10)",
  text: "#14161a",
  textMuted: "#6b7280",
  human: "#3b66e0",
  agent: "#0ea894",
  flag: "#e0973b",
};

const NODE_W = 176;
const NODE_H = 64;

// Mirrors the tools registered in the effect below — kept here as a flat,
// synchronous list so the UI can render a capabilities drawer without an
// async getTools() round-trip. Keep in sync if you add/remove a tool.
const TOOL_CATALOG = [
  { name: "get_canvas_state", desc: "Read all nodes & connections" },
  { name: "create_canvas_node", desc: "Add a node" },
  { name: "connect_nodes", desc: "Draw a connection" },
  { name: "auto_layout_nodes", desc: "Rearrange into grid/pipeline" },
  { name: "remove_node", desc: "Delete a node + its connections" },
  { name: "disconnect_nodes", desc: "Remove one connection" },
  { name: "flag_for_review", desc: "Flag a node (exposedTo reviewer origin)" },
];

// Origins allowed to see and call the review-flagging tool via WebMCP's
// exposedTo scoping — e.g. a design-review dashboard embedded as a
// cross-origin iframe with `allow="tools"`. Same-origin agents can always
// see same-origin tools regardless of this list; this only widens access
// to specific *other* origins for this one tool.
const REVIEWER_ORIGINS = ["https://webmcp-reviewer.example"];

const STORAGE_KEY = "nodecraft-canvas-v1";

const DEFAULT_HUMAN_NAME = "You";
const DEFAULT_AGENT_NAME = "AI Agent";

const DEFAULT_GRAPH = {
  nodes: [
    { id: "1", label: "User Client", type: "Frontend", x: 120, y: 210, origin: "human" },
    { id: "2", label: "WebMCP Host", type: "Runtime", x: 470, y: 210, origin: "human" },
  ],
  connections: [{ from: "1", to: "2" }],
};

function loadSavedGraph() {
  if (typeof window === "undefined") return { ...DEFAULT_GRAPH, humanName: DEFAULT_HUMAN_NAME, agentName: DEFAULT_AGENT_NAME };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRAPH, humanName: DEFAULT_HUMAN_NAME, agentName: DEFAULT_AGENT_NAME };

    const saved = JSON.parse(raw);
    if (!Array.isArray(saved?.nodes) || !Array.isArray(saved?.connections)) {
      return { ...DEFAULT_GRAPH, humanName: DEFAULT_HUMAN_NAME, agentName: DEFAULT_AGENT_NAME };
    }

    return {
      nodes: saved.nodes,
      connections: saved.connections,
      humanName:
        typeof saved.humanName === "string" && saved.humanName.trim()
          ? saved.humanName
          : DEFAULT_HUMAN_NAME,
      agentName:
        typeof saved.agentName === "string" && saved.agentName.trim()
          ? saved.agentName
          : DEFAULT_AGENT_NAME,
    };
  } catch {
    return { ...DEFAULT_GRAPH, humanName: DEFAULT_HUMAN_NAME, agentName: DEFAULT_AGENT_NAME };
  }
}

function nowLabel() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function App() {
  const [initialGraph] = useState(loadSavedGraph);
  const [nodes, setNodes] = useState(initialGraph.nodes);
  const [connections, setConnections] = useState(initialGraph.connections);
  const [humanName, setHumanName] = useState(initialGraph.humanName || DEFAULT_HUMAN_NAME);
  const [agentName, setAgentName] = useState(initialGraph.agentName || DEFAULT_AGENT_NAME);
  const [activity, setActivity] = useState([]);
  const [agentActive, setAgentActive] = useState(false);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [history, setHistory] = useState([]); // past snapshots: [{ nodes, connections }]
  const [future, setFuture] = useState([]); // redo stack, same shape
  const dragMoved = useRef(false);
  const dragStartSnapshotRef = useRef(null);

  const canvasRef = useRef(null);
  const importFileRef = useRef(null);
  const stateRef = useRef({ nodes, connections, selectedNodeId: null });
  const pulsesRef = useRef([]); // [{ nodeId, startedAt }]
  const rafRef = useRef(null);
  const agentTimeoutRef = useRef(null);
  const commitSeqRef = useRef(0); // identifies each undoable action, for reconciling with the activity log

  useEffect(() => {
    stateRef.current = { nodes, connections, selectedNodeId };
    drawCanvas();
  }, [nodes, connections, selectedNodeId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ nodes, connections, humanName, agentName })
      );
    } catch (err) {
      console.warn("Could not save canvas locally", err);
    }
  }, [nodes, connections, humanName, agentName]);

  // `commitSeq`, when given, ties this log line to a specific undoable
  // action so undo/redo can mark it reverted/restored later.
  const logActivity = (actor, text, commitSeq = null) => {
    setActivity(
      (prev) =>
        [{ id: `${Date.now()}-${Math.random()}`, actor, text, time: nowLabel(), commitSeq, reverted: false }, ...prev].slice(0, 8)
    );
    if (actor === "agent") {
      setAgentActive(true);
      clearTimeout(agentTimeoutRef.current);
      agentTimeoutRef.current = setTimeout(() => setAgentActive(false), 1400);
    }
  };

  const pulseNode = (nodeId) => {
    pulsesRef.current = [...pulsesRef.current, { nodeId, startedAt: performance.now() }];
    runAnimationLoop();
  };

  // Pushes a pre-change snapshot onto the undo stack and clears redo —
  // any new action invalidates whatever was available to redo. Returns the
  // seq assigned to this action so the caller can tag its activity log line.
  const commitSnapshot = (prevSnapshot) => {
    commitSeqRef.current += 1;
    const seq = commitSeqRef.current;
    setHistory((h) => [...h, { ...prevSnapshot, seq }].slice(-50));
    setFuture([]);
    return seq;
  };

  // Applies a state change while recording what came before it. `producer`
  // receives the current { nodes, connections } and returns the next value.
  // Returns the commit seq — pass it to logActivity to keep the feed in
  // sync with undo/redo.
  const commit = (producer) => {
    const prevSnapshot = { nodes: stateRef.current.nodes, connections: stateRef.current.connections };
    const next = producer(prevSnapshot);
    const seq = commitSnapshot(prevSnapshot);
    setNodes(next.nodes);
    setConnections(next.connections);
    return seq;
  };

  const undo = () => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    const current = { nodes: stateRef.current.nodes, connections: stateRef.current.connections, seq: last.seq };
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [...f, current]);
    setNodes(last.nodes);
    setConnections(last.connections);
    setActivity((prev) => prev.map((a) => (a.commitSeq === last.seq ? { ...a, reverted: true } : a)));
    logActivity("human", "Undid last change");
  };

  const redo = () => {
    if (future.length === 0) return;
    const last = future[future.length - 1];
    const current = { nodes: stateRef.current.nodes, connections: stateRef.current.connections, seq: last.seq };
    setFuture((f) => f.slice(0, -1));
    setHistory((h) => [...h, current]);
    setNodes(last.nodes);
    setConnections(last.connections);
    setActivity((prev) => prev.map((a) => (a.commitSeq === last.seq ? { ...a, reverted: false } : a)));
    logActivity("human", "Redid last change");
  };

  const removeNodeById = (id, actor = "agent") => {
    const node = stateRef.current.nodes.find((n) => n.id === id);
    if (!node) return false;
    const seq = commit(({ nodes, connections }) => ({
      nodes: nodes.filter((n) => n.id !== id),
      connections: connections.filter((c) => c.from !== id && c.to !== id),
    }));
    logActivity(actor, `Removed <b>${node.label}</b>`, seq);
    return true;
  };

  const startNewCanvas = () => {
    const confirmed = window.confirm(
      "Start a new canvas? Your current canvas will be replaced. Download JSON first if you want to keep it."
    );
    if (!confirmed) return;

    if (agentTimeoutRef.current) {
      clearTimeout(agentTimeoutRef.current);
      agentTimeoutRef.current = null;
    }

    setNodes(DEFAULT_GRAPH.nodes.map((node) => ({ ...node })));
    setConnections(DEFAULT_GRAPH.connections.map((connection) => ({ ...connection })));
    setActivity([]);
    setHistory([]);
    setFuture([]);
    setSelectedNodeId(null);
    setDraggingNodeId(null);
    setAgentActive(false);
    dragMoved.current = false;
    dragStartSnapshotRef.current = null;
    pulsesRef.current = [];
  };

  const downloadProject = () => {
    const project = {
      version: 1,
      exportedAt: new Date().toISOString(),
      humanName,
      agentName,
      nodes: stateRef.current.nodes,
      connections: stateRef.current.connections,
    };

    const blob = new Blob([JSON.stringify(project, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `nodecraft-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importProject = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const project = JSON.parse(await file.text());

      if (
        project?.version !== 1 ||
        !Array.isArray(project.nodes) ||
        !Array.isArray(project.connections)
      ) {
        throw new Error("Unsupported or invalid NodeCraft project file");
      }

      const validNodes = project.nodes.every(
        (node) =>
          node &&
          typeof node.id === "string" &&
          typeof node.label === "string" &&
          typeof node.x === "number" &&
          typeof node.y === "number"
      );

      const nodeIds = new Set(project.nodes.map((node) => node.id));
      const validConnections = project.connections.every(
        (connection) =>
          connection &&
          typeof connection.from === "string" &&
          typeof connection.to === "string" &&
          nodeIds.has(connection.from) &&
          nodeIds.has(connection.to)
      );

      if (!validNodes || !validConnections) {
        throw new Error("Project file contains invalid nodes or connections");
      }

      setNodes(project.nodes);
      setConnections(project.connections);
      setHistory([]);
      setFuture([]);
      setSelectedNodeId(null);
      setActivity([]);

      if (typeof project.humanName === "string" && project.humanName.trim()) {
        setHumanName(project.humanName);
      }
      if (typeof project.agentName === "string" && project.agentName.trim()) {
        setAgentName(project.agentName);
      }

      logActivity("human", `Imported <b>${file.name}</b>`);
    } catch (err) {
      console.error(err);
      window.alert("Could not import this NodeCraft project file.");
    }
  };

  const runAnimationLoop = () => {
    if (rafRef.current) return;
    const tick = () => {
      const now = performance.now();
      pulsesRef.current = pulsesRef.current.filter((p) => now - p.startedAt < 900);
      drawCanvas();
      if (pulsesRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const drawDotGrid = (ctx, w, h) => {
    ctx.fillStyle = COLORS.gridDot;
    const spacing = 26;
    for (let x = spacing; x < w; x += spacing) {
      for (let y = spacing; y < h; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const { nodes: curNodes, connections: curConns, selectedNodeId: curSelected } = stateRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawDotGrid(ctx, canvas.width, canvas.height);

    // Connections
    curConns.forEach((conn) => {
      const source = curNodes.find((n) => n.id === conn.from);
      const target = curNodes.find((n) => n.id === conn.to);
      if (!source || !target) return;

      const startX = source.x + NODE_W;
      const startY = source.y + NODE_H / 2;
      const endX = target.x;
      const endY = target.y + NODE_H / 2;
      const midX = startX + (endX - startX) / 2;

      const grad = ctx.createLinearGradient(startX, startY, endX, endY);
      grad.addColorStop(0, source.origin === "agent" ? COLORS.agent : COLORS.human);
      grad.addColorStop(1, target.origin === "agent" ? COLORS.agent : COLORS.human);

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(midX, startY, midX, endY, endX, endY);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Arrowhead
      const angle = Math.atan2(endY - startY, endX - midX);
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - 7 * Math.cos(angle - 0.4), endY - 7 * Math.sin(angle - 0.4));
      ctx.lineTo(endX - 7 * Math.cos(angle + 0.4), endY - 7 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = target.origin === "agent" ? COLORS.agent : COLORS.human;
      ctx.fill();
    });

    // Pulse rings (agent feedback)
    const now = performance.now();
    pulsesRef.current.forEach((p) => {
      const node = curNodes.find((n) => n.id === p.nodeId);
      if (!node) return;
      const t = (now - p.startedAt) / 900;
      const expand = t * 16;
      const alpha = Math.max(0, 1 - t);
      ctx.beginPath();
      ctx.roundRect(node.x - expand, node.y - expand, NODE_W + expand * 2, NODE_H + expand * 2, 14 + expand);
      ctx.strokeStyle = COLORS.agent;
      ctx.globalAlpha = alpha * 0.55;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Nodes
    curNodes.forEach((node) => {
      const accent = node.origin === "agent" ? COLORS.agent : COLORS.human;
      const isPulsing = pulsesRef.current.some((p) => p.nodeId === node.id);

      ctx.save();
      if (isPulsing) {
        ctx.shadowColor = accent;
        ctx.shadowBlur = 18;
      } else {
        ctx.shadowColor = "rgba(20, 22, 30, 0.12)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 5;
      }

      ctx.fillStyle = COLORS.cardFill;
      ctx.strokeStyle = COLORS.cardBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(node.x, node.y, NODE_W, NODE_H, 12);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Origin accent bar
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(node.x, node.y, 3, NODE_H, [12, 0, 0, 12]);
      ctx.fill();

      ctx.fillStyle = COLORS.text;
      ctx.font = "600 13.5px 'Space Grotesk', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(node.label, node.x + 16, node.y + 27);

      ctx.fillStyle = COLORS.textMuted;
      ctx.font = "500 10.5px 'JetBrains Mono', monospace";
      ctx.fillText((node.type || "Component").toUpperCase(), node.x + 16, node.y + 46);

      // Ports
      [node.x, node.x + NODE_W].forEach((px) => {
        ctx.beginPath();
        ctx.arc(px, node.y + NODE_H / 2, 4, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.cardFill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = accent;
        ctx.stroke();
      });

      if (node.id === curSelected) {
        ctx.save();
        ctx.shadowColor = COLORS.human;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.roundRect(node.x - 3, node.y - 3, NODE_W + 6, NODE_H + 6, 14);
        ctx.strokeStyle = COLORS.human;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      }

      if (node.flagged) {
        const bx = node.x + NODE_W - 9;
        const by = node.y + 9;
        ctx.beginPath();
        ctx.arc(bx, by, 6, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.flag;
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 9px 'Inter', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("!", bx, by + 3);
        ctx.textAlign = "left";
      }
    });
  };

  const getMousePos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const handleMouseDown = (e) => {
    const { x: mouseX, y: mouseY } = getMousePos(e);
    const clickedNode = nodes.find(
      (node) => mouseX >= node.x && mouseX <= node.x + NODE_W && mouseY >= node.y && mouseY <= node.y + NODE_H
    );
    setSelectedNodeId(clickedNode ? clickedNode.id : null);
    if (clickedNode) {
      setDraggingNodeId(clickedNode.id);
      dragMoved.current = false;
      dragStartSnapshotRef.current = { nodes: stateRef.current.nodes, connections: stateRef.current.connections };
      setDragOffset({ x: mouseX - clickedNode.x, y: mouseY - clickedNode.y });
    }
  };

  const handleMouseMove = (e) => {
    if (!draggingNodeId) return;
    dragMoved.current = true;
    const { x: mouseX, y: mouseY } = getMousePos(e);
    setNodes((prev) =>
      prev.map((node) =>
        node.id === draggingNodeId ? { ...node, x: mouseX - dragOffset.x, y: mouseY - dragOffset.y } : node
      )
    );
  };

  const handleMouseUp = () => {
    if (draggingNodeId && dragMoved.current) {
      const node = stateRef.current.nodes.find((n) => n.id === draggingNodeId);
      const seq = dragStartSnapshotRef.current ? commitSnapshot(dragStartSnapshotRef.current) : null;
      if (node) logActivity("human", `Moved <b>${node.label}</b>`, seq);
    }
    dragStartSnapshotRef.current = null;
    setDraggingNodeId(null);
  };

  const handleKeyDown = (e) => {
    const { selectedNodeId: curSelected } = stateRef.current;
    if (!curSelected) return;

    const arrowDeltas = {
      ArrowUp: { dx: 0, dy: -1 },
      ArrowDown: { dx: 0, dy: 1 },
      ArrowLeft: { dx: -1, dy: 0 },
      ArrowRight: { dx: 1, dy: 0 },
    };

    if (arrowDeltas[e.key]) {
      e.preventDefault();
      const step = e.shiftKey ? 24 : 8;
      const { dx, dy } = arrowDeltas[e.key];
      commit(({ nodes, connections }) => ({
        nodes: nodes.map((node) =>
          node.id === curSelected ? { ...node, x: node.x + dx * step, y: node.y + dy * step } : node
        ),
        connections,
      }));
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeNodeById(curSelected, "human");
      setSelectedNodeId(null);
      return;
    }

    if (e.key === "Escape") {
      setSelectedNodeId(null);
    }
  };

  useEffect(() => {
    const onGlobalKeyDown = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [history, future]);

  useEffect(() => {
    if (typeof document !== "undefined" && document.modelContext) {
      // WebMCP has no unregisterTool() — a tool is removed by aborting the
      // AbortSignal passed in at registration time. See:
      // https://webmachinelearning.github.io/webmcp/
      const controller = new AbortController();
      const { signal } = controller;

      const safeRegister = (toolDef, extraOptions = {}) => {
        document.modelContext.registerTool(toolDef, { signal, ...extraOptions }).catch((err) => {
          // Aborting a pending registration also rejects its promise —
          // that's expected on cleanup/unmount, not a real error.
          if (err?.name !== "AbortError") console.error(err);
        });
      };

      safeRegister({
        name: "get_canvas_state",
        description:
          "Returns every node (id, label, type, position, origin, flagged) and every connection currently on the canvas. Call this before auto_layout_nodes or connect_nodes if you need to reason about the current layout rather than act blind.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => ({
          status: "success",
          nodes: stateRef.current.nodes,
          connections: stateRef.current.connections,
        }),
      });

      safeRegister({
        name: "create_canvas_node",
        description: "Creates a new architectural node on the visual canvas.",
        inputSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Visible title of the node",
            },
            type: {
              type: "string",
              description: "Architectural component type, for example Frontend, Service, Database, Cache, Queue, or External",
            },
            x: {
              type: "number",
              description: "Horizontal canvas position in pixels",
            },
            y: {
              type: "number",
              description: "Vertical canvas position in pixels",
            },
          },
          required: ["label"],
        },
        execute: async (input) => {
          const newNode = {
            id: String(Date.now()),
            label: input.label,
            type: input.type || "Service",
            x: input.x || Math.floor(Math.random() * 400) + 100,
            y: input.y || Math.floor(Math.random() * 200) + 100,
            origin: "agent",
          };
          const seq = commit(({ nodes, connections }) => ({ nodes: [...nodes, newNode], connections }));
          logActivity("agent", `Created <b>${newNode.label}</b>`, seq);
          pulseNode(newNode.id);
          return { status: "success", nodeId: newNode.id };
        },
      });

      safeRegister({
        name: "connect_nodes",
        description: "Connects two canvas nodes with a bezier curve.",
        inputSchema: {
          type: "object",
          properties: {
            fromLabel: {
              type: "string",
              description: "Label or partial label of the source node",
            },
            toLabel: {
              type: "string",
              description: "Label or partial label of the destination node",
            },
          },
          required: ["fromLabel", "toLabel"],
        },
        execute: async (input) => {
          const currentNodes = stateRef.current.nodes;
          const source = currentNodes.find((n) => n.label.toLowerCase().includes(input.fromLabel.toLowerCase()));
          const target = currentNodes.find((n) => n.label.toLowerCase().includes(input.toLabel.toLowerCase()));
          if (!source || !target) return { status: "error", error: "Nodes not found" };

          const alreadyConnected = stateRef.current.connections.some(
            (connection) => connection.from === source.id && connection.to === target.id
          );
          if (alreadyConnected) return { status: "error", error: "Nodes already connected" };

          const seq = commit(({ nodes, connections }) => ({
            nodes,
            connections: [...connections, { from: source.id, to: target.id }],
          }));
          logActivity("agent", `Connected <b>${source.label}</b> → <b>${target.label}</b>`, seq);
          pulseNode(source.id);
          pulseNode(target.id);
          return { status: "success" };
        },
      });

      safeRegister({
        name: "auto_layout_nodes",
        description: "Automatically rearranges canvas nodes into a grid or pipeline.",
        inputSchema: {
          type: "object",
          properties: {
            layoutType: { type: "string", enum: ["horizontal", "grid"] },
          },
          required: ["layoutType"],
        },
        execute: async (input) => {
          const seq = commit(({ nodes, connections }) => ({
            nodes: nodes.map((node, idx) =>
              input.layoutType === "horizontal"
                ? { ...node, x: 80 + idx * 210, y: 200 }
                : { ...node, x: 90 + (idx % 3) * 230, y: 70 + Math.floor(idx / 3) * 140 }
            ),
            connections,
          }));
          logActivity("agent", `Rearranged layout · <b>${input.layoutType}</b>`, seq);
          stateRef.current.nodes.forEach((n) => pulseNode(n.id));
          return { status: "success" };
        },
      });

      safeRegister({
        name: "remove_node",
        description: "Removes a node from the canvas by label, along with any connections to it.",
        inputSchema: {
          type: "object",
          properties: {
            label: { type: "string", description: "Label (or partial label) of the node to remove" },
          },
          required: ["label"],
        },
        execute: async (input) => {
          const node = stateRef.current.nodes.find((n) => n.label.toLowerCase().includes(input.label.toLowerCase()));
          if (!node) return { status: "error", error: "Node not found" };
          removeNodeById(node.id, "agent");
          return { status: "success" };
        },
      });

      safeRegister({
        name: "disconnect_nodes",
        description: "Removes the connection between two nodes, if one exists.",
        inputSchema: {
          type: "object",
          properties: {
            fromLabel: {
              type: "string",
              description: "Label or partial label of the source node",
            },
            toLabel: {
              type: "string",
              description: "Label or partial label of the destination node",
            },
          },
          required: ["fromLabel", "toLabel"],
        },
        execute: async (input) => {
          const currentNodes = stateRef.current.nodes;
          const source = currentNodes.find((n) => n.label.toLowerCase().includes(input.fromLabel.toLowerCase()));
          const target = currentNodes.find((n) => n.label.toLowerCase().includes(input.toLabel.toLowerCase()));
          if (!source || !target) return { status: "error", error: "Nodes not found" };

          const existed = stateRef.current.connections.some((c) => c.from === source.id && c.to === target.id);
          if (!existed) return { status: "error", error: "No connection between those nodes" };

          const seq = commit(({ nodes, connections }) => ({
            nodes,
            connections: connections.filter((c) => !(c.from === source.id && c.to === target.id)),
          }));
          logActivity("agent", `Disconnected <b>${source.label}</b> → <b>${target.label}</b>`, seq);
          return { status: "success" };
        },
      });

      // Scoped to REVIEWER_ORIGINS via exposedTo — a same-origin agent can
      // still call it (same-origin access isn't restricted by exposedTo),
      // but a cross-origin iframe can only reach this tool if its origin is
      // in the list *and* it was given the "tools" Permissions Policy.
      safeRegister(
        {
          name: "flag_for_review",
          description: "Marks a node as flagged for design review.",
          inputSchema: {
            type: "object",
            properties: {
              label: { type: "string", description: "Label (or partial label) of the node to flag" },
            },
            required: ["label"],
          },
          execute: async (input) => {
            const node = stateRef.current.nodes.find((n) => n.label.toLowerCase().includes(input.label.toLowerCase()));
            if (!node) return { status: "error", error: "Node not found" };
            const seq = commit(({ nodes, connections }) => ({
              nodes: nodes.map((n) => (n.id === node.id ? { ...n, flagged: true } : n)),
              connections,
            }));
            logActivity("agent", `Flagged <b>${node.label}</b> for review`, seq);
            pulseNode(node.id);
            return { status: "success" };
          },
        },
        { exposedTo: REVIEWER_ORIGINS }
      );

      // Unregisters all tools registered above (that's what the spec's
      // AbortSignal-based teardown does) — runs on unmount, and on
      // StrictMode's dev-only extra mount/cleanup pass.
      return () => controller.abort();
    }
  }, []);

  const canUndo = history.length > 0;
  const canRedo = future.length > 0;

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand-block">
          <svg className="brand-mark" viewBox="0 0 30 30" fill="none">
            <circle cx="8" cy="15" r="4" fill={COLORS.human} />
            <circle cx="22" cy="8" r="4" fill={COLORS.agent} />
            <circle cx="22" cy="22" r="4" fill={COLORS.agent} opacity="0.5" />
            <path d="M11.5 14 L18.5 9" stroke="rgba(255,255,255,0.25)" strokeWidth="1.4" />
            <path d="M11.5 16 L18.5 21" stroke="rgba(255,255,255,0.25)" strokeWidth="1.4" />
          </svg>
          <div className="brand-copy">
            <span className="brand-name">NodeCraft</span>
            <span className="brand-subtitle">Shared canvas · human + agent</span>
          </div>
        </div>

        <div className="history-controls">
          <button type="button" className="history-btn" onClick={undo} disabled={!canUndo} aria-label="Undo">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M9 7L4 12l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 12h11a5 5 0 0 1 0 10h-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="history-btn" onClick={redo} disabled={!canRedo} aria-label="Redo">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M15 7l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 12H9a5 5 0 0 0 0 10h1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="project-controls">
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className="import-file-input"
            onChange={importProject}
          />
          <button type="button" className="project-btn" onClick={startNewCanvas}>
            New Canvas
          </button>
          <button type="button" className="project-btn" onClick={downloadProject}>
            Download JSON
          </button>
          <button
            type="button"
            className="project-btn"
            onClick={() => importFileRef.current?.click()}
          >
            Import JSON
          </button>
        </div>

        <div className="presence">
          <label className="presence-chip human" title="Edit your name">
            <span className="dot" />
            <input
              className="presence-name"
              value={humanName}
              onChange={(e) => setHumanName(e.target.value)}
              onBlur={() => {
                if (!humanName.trim()) setHumanName(DEFAULT_HUMAN_NAME);
              }}
              aria-label="Human name"
              maxLength={24}
            />
          </label>
          <label className={`presence-chip agent${agentActive ? " active" : ""}`} title="Edit agent name">
            <span className="dot" />
            <input
              className="presence-name"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              onBlur={() => {
                if (!agentName.trim()) setAgentName(DEFAULT_AGENT_NAME);
              }}
              aria-label="AI agent name"
              maxLength={24}
            />
          </label>
        </div>
      </header>

      <main className="workspace">
        <section className="canvas-panel">
          <canvas
            ref={canvasRef}
            width={950}
            height={650}
            tabIndex={0}
            role="application"
            aria-label="System diagram canvas. Click a node to select it, then use arrow keys to move it, or Delete to remove it."
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onKeyDown={handleKeyDown}
            className={draggingNodeId ? "dragging" : ""}
          />
          {nodes.length === 2 && activity.length === 0 && (
            <div className="agent-build-hint">Ask your AI agent to build on this canvas</div>
          )}
          <span className="canvas-hint">click a node → arrow keys to nudge, ⇧ for bigger steps, Delete to remove</span>
        </section>

        <aside className="inspector-panel">
          <div className="panel-block">
            <div className="panel-title">Activity</div>
            <div className="activity-list">
              {activity.length === 0 ? (
                <div className="activity-empty">Nothing yet — move a node, or ask the agent to add one.</div>
              ) : (
                activity.map((a) => (
                  <div key={a.id} className={`activity-row ${a.actor}${a.reverted ? " reverted" : ""}`}>
                    <span className="actor-dot" />
                    <div className="activity-copy">
                      <span className="activity-actor">
                        {a.actor === "agent" ? agentName : humanName}
                      </span>
                      <span className="activity-text" dangerouslySetInnerHTML={{ __html: a.text }} />
                    </div>
                    <span className="activity-meta">
                      {a.reverted && <span className="reverted-tag">reverted</span>}
                      <span className="activity-time">{a.time}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel-block grow">
            <div className="panel-title">
              Graph hierarchy
              <span className="count">{nodes.length}</span>
            </div>
            <div className="node-list">
              {nodes.map((node) => (
                <div
                  key={node.id}
                  className={`node-item origin-${node.origin || "human"}${node.id === selectedNodeId ? " selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedNodeId(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedNodeId(node.id);
                    }
                  }}
                >
                  <div className="node-meta">
                    <span className="node-icon">
                      {node.origin === "agent" ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <rect x="4" y="8" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M12 8V4" stroke="currentColor" strokeWidth="1.8" />
                          <circle cx="12" cy="3" r="1.4" fill="currentColor" />
                          <circle cx="9" cy="14" r="1.3" fill="currentColor" />
                          <circle cx="15" cy="14" r="1.3" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M5 20c1.2-4 4-6 7-6s5.8 2 7 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      )}
                    </span>
                    <div>
                      <div className="node-name">{node.label}</div>
                      <div className="node-type">{node.type || "Component"}</div>
                    </div>
                  </div>
                  <span className="node-coords">{Math.round(node.x)}, {Math.round(node.y)}</span>
                  <button
                    type="button"
                    className="node-delete-btn"
                    aria-label={`Remove ${node.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeNodeById(node.id, "human");
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <div className="panel-footer-row">
              <button
                type="button"
                className="tools-toggle"
                onClick={() => setToolsOpen((v) => !v)}
                aria-expanded={toolsOpen}
              >
                <span className="tools-toggle-dot" />
                WebMCP tools ({TOOL_CATALOG.length})
                <svg
                  className={`tools-chevron${toolsOpen ? " open" : ""}`}
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="engine-tag">React + Canvas API</span>
            </div>
            {toolsOpen && (
              <ul className="tools-drawer">
                {TOOL_CATALOG.map((t) => (
                  <li key={t.name}>
                    <code>{t.name}</code>
                    <span>{t.desc}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}