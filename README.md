# webmcp-canvas-builder

## Why this use case is a strong fit for WebMCP

Traditional AI tools output static code or images, forcing users to leave their workspace to copy-paste results. This visual canvas utilizes WebMCP to allow the AI agent to manipulate the live DOM and canvas state directly. Both the human and the agent edit the exact same workspace simultaneously without abstract text barriers.

## How it creates a better user experience

It eliminates prompt-engineering friction and context loss. The user can manually drag a node into place, then simply ask the agent to "connect the database to the API" or "rearrange these nodes into a grid." The agent executes these actions instantly on the active web page, providing immediate, visual side-by-side feedback. The current canvas and editable participant names are persisted locally in the browser, so the workspace survives refreshes and can be resumed later. Undo/redo history remains session-scoped.

## What people and agents can do together that was difficult/impossible before

Previously, bi-directional visual co-creation was impossible. An AI could generate a flowchart, but a human couldn't manually drag one piece and ask the AI to recalculate the rest of the layout natively in the browser. WebMCP bridges this gap, turning the AI from a passive chatbot into an active design co-pilot that shares the same real-time visual context as the user.

## How WebMCP was implemented

The application is built using React and HTML5 Canvas. WebMCP is implemented directly in the frontend lifecycle using document.modelContext.registerTool(). Tools like create_canvas_node, connect_nodes, and auto_layout_nodes are registered with JSON inputSchema definitions that describe the inputs available to the agent. get_canvas_state is explicitly annotated as read-only. When the agent executes a mutating tool, the payload updates the local React state arrays, instantly triggering a re-render of the canvas to reflect the change. Tools are registered with an AbortSignal so they can be cleanly unregistered on unmount, per the WebMCP spec. Human and agent identities are editable and persisted locally, making actions clearly attributable in the activity feed.

## Tools

All seven tools are registered in App.jsx inside a single useEffect, scoped to one AbortController for lifecycle cleanup. Every action is origin-tagged (agent vs human) and surfaced using editable participant names in the on-canvas activity feed, so a reviewer can see — not just infer — who changed what.

### get_canvas_state

Read-only. Returns the full current graph — call this before auto_layout_nodes or connect_nodes if the agent needs to reason about what's already there instead of acting blind.

{
  "name": "get_canvas_state",
  "description": "Returns every node (id, label, type, position, origin, flagged) and every connection currently on the canvas.",
  "inputSchema": { "type": "object", "properties": {} },
  "annotations": { "readOnlyHint": true }
}

Returns: { status: "success", nodes: [...], connections: [...] }

### create_canvas_node

Creates a new node on the canvas.

{
  "name": "create_canvas_node",
  "description": "Creates a new architectural node on the visual canvas.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "description": "Visible title of the node" },
      "type": { "type": "string", "description": "Architectural component type, for example Frontend, Service, Database, Cache, Queue, or External" },
      "x": { "type": "number", "description": "Horizontal canvas position in pixels" },
      "y": { "type": "number", "description": "Vertical canvas position in pixels" }
    },
    "required": ["label"]
  }
}

Returns: { status: "success", nodeId: string }

Example call:

const tools = await document.modelContext.getTools();

const tool = tools.find(t => t.name === "create_canvas_node");

await document.modelContext.executeTool(
  tool,
  JSON.stringify({ label: "Postgres DB", type: "Database" })
);

### connect_nodes

Draws a connection between two existing nodes, matched by (partial, case-insensitive) label.

{
  "name": "connect_nodes",
  "description": "Connects two canvas nodes with a bezier curve.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "fromLabel": { "type": "string", "description": "Label or partial label of the source node" },
      "toLabel": { "type": "string", "description": "Label or partial label of the destination node" }
    },
    "required": ["fromLabel", "toLabel"]
  }
}

Returns: { status: "success" }, { status: "error", error: "Nodes not found" }, or { status: "error", error: "Nodes already connected" }

Example call:

const tools = await document.modelContext.getTools();

const tool = tools.find(t => t.name === "connect_nodes");

await document.modelContext.executeTool(
  tool,
  JSON.stringify({ fromLabel: "Postgres DB", toLabel: "WebMCP Host" })
);

### auto_layout_nodes

Rearranges every node on the canvas into a horizontal pipeline or a grid.

{
  "name": "auto_layout_nodes",
  "description": "Automatically rearranges canvas nodes into a grid or pipeline.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "layoutType": { "type": "string", "enum": ["horizontal", "grid"] }
    },
    "required": ["layoutType"]
  }
}

Returns: { status: "success" }

Example call:

const tools = await document.modelContext.getTools();

const tool = tools.find(t => t.name === "auto_layout_nodes");

await document.modelContext.executeTool(
  tool,
  JSON.stringify({ layoutType: "grid" })
);

Note on executeTool: Chrome's current WebMCP implementation expects manually supplied tool arguments as a valid JSON string, so the examples below use JSON.stringify(...). The WebMCP specification is still evolving, and the latest draft describes executeTool() with an object input, so this may change as Chrome converges on the spec.

### remove_node

Removes a node (and any connections to it) by label.

{
  "name": "remove_node",
  "description": "Removes a node from the canvas by label, along with any connections to it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "description": "Label (or partial label) of the node to remove" }
    },
    "required": ["label"]
  }
}

Returns: { status: "success" } or { status: "error", error: "Node not found" }

### disconnect_nodes

Removes the connection between two nodes, if one exists.

{
  "name": "disconnect_nodes",
  "description": "Removes the connection between two nodes, if one exists.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "fromLabel": { "type": "string", "description": "Label or partial label of the source node" },
      "toLabel": { "type": "string", "description": "Label or partial label of the destination node" }
    },
    "required": ["fromLabel", "toLabel"]
  }
}

Returns: { status: "success" } or { status: "error", error: "No connection between those nodes" }

These close the symmetry gap in the first version of this app, where the agent could only add to the canvas. A human can now also delete a node from the sidebar (× button, or select + press Delete/Backspace on the canvas).

### flag_for_review — scoped with exposedTo

Unlike the tools above, this tool demonstrates WebMCP's cross-origin permission model.

document.modelContext.registerTool(
  {
    name: "flag_for_review",
    description: "Marks a node as flagged for design review.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" }
      },
      required: ["label"],
    },
    execute: async (input) => {
      /* ... */
    },
  },
  {
    exposedTo: ["https://webmcp-reviewer.example"]
  }
);

exposedTo allows this specific tool to be discovered and executed by the listed cross-origin document. Same-origin access continues to work normally.

For cross-origin access, three things must line up:

The reviewer origin must be listed in the tool's exposedTo configuration.

The canvas iframe must be granted the WebMCP tools Permissions Policy using allow="tools".

The reviewer must explicitly request tools from the canvas origin using getTools({ fromOrigins: [...] }).

## Testing the cross-origin flow

A real cross-origin test requires two different origins.

Assume:

Canvas:   https://canvas.example
Reviewer: https://reviewer.example

Set the reviewer origin in App.jsx:

const REVIEWER_ORIGINS = ["https://reviewer.example"];

The reviewer page embeds NodeCraft:

<iframe
  src="https://canvas.example"
  allow="tools"
></iframe>

Then the reviewer page discovers tools exposed by the canvas:

const tools = await document.modelContext.getTools({
  fromOrigins: ["https://canvas.example"],
});

const flagTool = tools.find(
  (tool) => tool.name === "flag_for_review"
);

console.log(flagTool);

The reviewer can then execute the exposed tool:

await document.modelContext.executeTool(
  flagTool,
  JSON.stringify({ label: "WebMCP Host" })
);

The important point is that the reviewer does not directly access the iframe's contentDocument. Normal browser same-origin rules still apply. Instead, WebMCP allows the parent document to discover authorized tools from descendant frames through getTools({ fromOrigins: [...] }).

Other NodeCraft tools remain unavailable cross-origin because only flag_for_review is registered with exposedTo.

Note: Chrome currently requires cross-origin entries supplied through exposedTo and fromOrigins to be secure origins. For the most reliable cross-origin demo, use HTTPS origins.

## Testing tools manually

With the app running and a WebMCP-enabled browser (or the MCP-B polyfill):

// List everything currently registered

const tools = await document.modelContext.getTools();

console.log(tools.map(t => t.name));

// → [
//   "get_canvas_state",
//   "create_canvas_node",
//   "connect_nodes",
//   "auto_layout_nodes",
//   "remove_node",
//   "disconnect_nodes",
//   "flag_for_review"
// ]

// Same-origin discovery sees all seven tools. `exposedTo` additionally
// allows the explicitly listed reviewer origin to discover flag_for_review.

// Invoke one

const layoutTool = tools.find(t => t.name === "auto_layout_nodes");

await document.modelContext.executeTool(
  layoutTool,
  JSON.stringify({ layoutType: "grid" })
);