if (!game.user.isGM) return ui.notifications.warn('日历与天气同步仅供 GM 使用。');
const companion = game.modules.get('pf2e-bob-companion')?.api;
if (!companion?.syncCalendar) return ui.notifications.warn('请启用 BoB 伴随模组并刷新页面。');
const result = await companion.syncCalendar({force: true});
const message = result?.detail || result?.label || '同步请求已处理，请在 BoB 面板查看状态。';
ui.notifications[result?.state === 'synced' ? 'info' : 'warn'](message);
return result;
