if (!game.user.isGM) return ui.notifications.warn('此入口仅供 GM 使用。');
const api = game.modules.get('pf2e-bob-companion')?.api;
if (!api?.openAssistants) return ui.notifications.warn('请启用 BoB 伴随模组并刷新页面。');
await api.openAssistants();
