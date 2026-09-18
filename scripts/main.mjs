import { registerRuntime } from './runtime.mjs';
import { registerUI } from './ui.mjs';
import { registerCalendar } from './calendar.mjs';
Hooks.once('init', () => { registerRuntime(); registerCalendar(); registerUI(); });
