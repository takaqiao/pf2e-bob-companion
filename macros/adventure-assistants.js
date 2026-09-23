const localize = (key, fallback) => game.i18n.has(`BOB.${key}`) ? game.i18n.localize(`BOB.${key}`) : fallback;
if (!game.user.isGM) return ui.notifications.warn(localize('Common.GMOnly', 'Only a GM can use this tool.'));
const api = game.modules.get('pf2e-bob-companion')?.api;
if (!api?.openAssistants) return ui.notifications.warn(localize('Common.EnableModule', 'Enable BoB Companion and reload.'));
await api.openAssistants();
