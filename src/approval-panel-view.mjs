export const PANEL_URI='ui://zanallaima/approval-panel-v1.html';
export const PANEL_MIME='text/html;profile=mcp-app';
export function panelHtml(){return '<!doctype html><html lang="es"><body><main id="app"></main><script>window.parent.postMessage({jsonrpc:"2.0",id:1,method:"incorrecto",params:{}},"*")</script></body></html>';}
