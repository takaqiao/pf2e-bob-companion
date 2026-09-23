import { registerRuntime } from './runtime.mjs';
import { registerUI } from './ui.mjs';
import { registerCalendar } from './calendar.mjs';
import { registerAssistantCore } from './assistant-core.mjs';
import { registerAssistants } from './assistants.mjs';
import { registerNightmares } from './nightmares.mjs';
import { registerBoons } from './boons.mjs';
import { registerSoulhearts } from './soulhearts.mjs';
import { registerHazards } from './hazards.mjs';
Hooks.once('init', () => {
  registerRuntime(); registerCalendar(); registerAssistantCore();
  registerNightmares(); registerBoons(); registerSoulhearts(); registerHazards();
  registerAssistants(); registerUI();
});
