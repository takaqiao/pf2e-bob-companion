import { registerRuntime } from './runtime.mjs';
import { registerUI } from './ui.mjs';
Hooks.once('init', () => { registerRuntime(); registerUI(); });
