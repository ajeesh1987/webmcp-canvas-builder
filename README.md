# webmcp-canvas-builder

**Why this use case is a strong fit for WebMCP:** Traditional AI tools output static code or images, forcing users to leave their workspace to copy-paste results. This visual canvas utilizes WebMCP to allow the AI agent to manipulate the live DOM and canvas state directly. Both the human and the agent edit the exact same workspace simultaneously without abstract text barriers.

**How it creates a better user experience:** It eliminates prompt-engineering friction and context loss. The user can manually drag a node into place, then simply ask the agent to "connect the database to the API" or "rearrange these nodes into a grid." The agent executes these actions instantly on the active web page, providing immediate, visual side-by-side feedback.

**What people and agents can do together that was difficult/impossible before:** Previously, bi-directional visual co-creation was impossible. An AI could generate a flowchart, but a human couldn't manually drag one piece and ask the AI to recalculate the rest of the layout natively in the browser. WebMCP bridges this gap, turning the AI from a passive chatbot into an active design co-pilot that shares the same real-time visual context as the user.

**How WebMCP was implemented:** The application is built using React and HTML5 Canvas. WebMCP is implemented directly in the frontend lifecycle using `document.modelContext.registerTool()`. Tools like `create_canvas_node`, `connect_nodes`, and `auto_layout_nodes` are registered with strict JSON `inputSchema` definitions. When the agent executes a tool, the payload updates the local React state arrays, instantly triggering a re-render of the canvas to reflect the agent's changes. Tools are registered with an `AbortSignal` so they can be cleanly unregistered on unmount, per the WebMCP spec.

---

## Tools

All three tools are registered in `App.jsx` inside a single `useEffect`, scoped to one `AbortController` for lifecycle cleanup. Every action an agent takes is origin-tagged (`agent` vs `human`) and surfaced in the on-canvas activity feed, so a reviewer can see — not just infer — what the agent changed.

### `create_canvas_node`
Creates a new node on the canvas.

```json
{
  "name": "create_canvas_node",
  "description": "Creates a new architectural node on the visual canvas.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "description": "Node title" },
      "type": { "type": "string", "description": "Component type (e.g., Database, Service)" },
      "x": { "type": "number" },
      "y": { "type": "number" }
    },
    "required": ["label"]
  }
}
```

**Returns:** `{ status: "success", nodeId: string }`

**Example call:**
```js
const tools = await document.modelContext.getTools();
const tool = tools.find(t => t.name === "create_canvas_node");
await document.modelContext.executeTool(
  tool,
  JSON.stringify({ label: "Postgres DB", type: "Database" })
);
```

### `connect_nodes`
Draws a connection between two existing nodes, matched by (partial, case-insensitive) label.

```json
{
  "name": "connect_nodes",
  "description": "Connects two canvas nodes with a bezier curve.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "fromLabel": { "type": "string" },
      "toLabel": { "type": "string" }
    },
    "required": ["fromLabel", "toLabel"]
  }
}
```

**Returns:** `{ status: "success" }` or `{ status: "error", error: "Nodes not found" }`

**Example call:**
```js
const tools = await document.modelContext.getTools();
const tool = tools.find(t => t.name === "connect_nodes");
await document.modelContext.executeTool(
  tool,
  JSON.stringify({ fromLabel: "Postgres DB", toLabel: "WebMCP Host" })
);
```

### `auto_layout_nodes`
Rearranges every node on the canvas into a horizontal pipeline or a grid.

```json
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
```

**Returns:** `{ status: "success" }`

**Example call:**
```js
const tools = await document.modelContext.getTools();
const tool = tools.find(t => t.name === "auto_layout_nodes");
await document.modelContext.executeTool(
  tool,
  JSON.stringify({ layoutType: "grid" })
);
```

> **Note on `executeTool`:** the current Chrome implementation expects the second argument as a **JSON string**, not a live object — it calls `JSON.parse()` on it internally. Always `JSON.stringify()` your input when calling `executeTool` manually from the console or a test harness.

### `remove_node`
Removes a node (and any connections to it) by label.

```json
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
```

**Returns:** `{ status: "success" }` or `{ status: "error", error: "Node not found" }`

### `disconnect_nodes`
Removes the connection between two nodes, if one exists.

```json
{
  "name": "disconnect_nodes",
  "description": "Removes the connection between two nodes, if one exists.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "fromLabel": { "type": "string" },
      "toLabel": { "type": "string" }
    },
    "required": ["fromLabel", "toLabel"]
  }
}
```

**Returns:** `{ status: "success" }` or `{ status: "error", error: "No connection between those nodes" }`

These close the symmetry gap in the first version of this app, where the agent could only add to the canvas. A human can now also delete a node from the sidebar (× button, or select + press Delete/Backspace on the canvas).

### `flag_for_review` — scoped with `exposedTo`

Unlike the tools above, this one is **not** registered with default (same-origin-only) visibility. It demonstrates WebMCP's cross-origin permission model:

```js
document.modelContext.registerTool(
  {
    name: "flag_for_review",
    description: "Marks a node as flagged for design review.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    },
    execute: async (input) => { /* ... */ },
  },
  { exposedTo: ["https://webmcp-reviewer.example"] }
);
```

`exposedTo` widens visibility of *this specific tool* to the listed origins, on top of the default same-origin access every tool already has. A cross-origin document can only see or call it if:
1. its origin is in the `exposedTo` list, **and**
2. it's been granted the `tools` Permissions Policy — e.g. `<iframe src="https://webmcp-reviewer.example" allow="tools"></iframe>`.

**To test this for real** (a single page can't demo cross-origin access to itself):
1. Serve this app on one local origin, e.g. `http://localhost:5173`.
2. Serve a second minimal page — the "reviewer" — on a different origin, e.g. `http://localhost:5174`.
3. Embed the canvas app in the reviewer page: `<iframe src="http://localhost:5173" allow="tools"></iframe>`.
4. From the reviewer page's script, reach into the iframe's `contentDocument.modelContext` (or use `getTools({ exposedTo: true })` per spec) and call `flag_for_review`.
5. Change `REVIEWER_ORIGINS` in `App.jsx` to match your reviewer's real origin — `https://webmcp-reviewer.example` is a placeholder.

Without step 5, no cross-origin caller will be able to reach the tool — same-origin agents (the ones actually driving the demo) are unaffected either way.

---

## Testing tools manually

With the app running and a WebMCP-enabled browser (or the [MCP-B polyfill](https://github.com/WebMCP-org/npm-packages)):

```js
// List everything currently registered
const tools = await document.modelContext.getTools();
console.log(tools.map(t => t.name));
// → ["create_canvas_node", "connect_nodes", "auto_layout_nodes", "remove_node", "disconnect_nodes"]
// ("flag_for_review" only appears here too if called same-origin — it's
// otherwise scoped to REVIEWER_ORIGINS, see above)

// Invoke one
const layoutTool = tools.find(t => t.name === "auto_layout_nodes");
await document.modelContext.executeTool(layoutTool, JSON.stringify({ layoutType: "grid" }));
```