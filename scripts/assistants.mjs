import {ID} from './model.mjs';
import {escapeHtml as esc,withAction} from './assistant-core.mjs';
import {t} from './i18n.mjs';

const entries = [
  ['openNightmares','Hub.Rest','Hub.RestHint'],
  ['openBoons','Hub.Boons','Hub.BoonsHint'],
  ['openHazards','Hub.Hazards','Hub.HazardsHint'],
  ['openSoulhearts','Hub.Soulhearts','Hub.SoulheartsHint']
];
const macros = [
  ['Hub.Title','openAssistants','icons/sundries/books/book-symbol-eye-purple.webp'],
  ['Hub.UseSoulheart','openSoulhearts','icons/commodities/gems/gem-faceted-round-purple.webp']
];
export async function installAssistantMacros() {
  return withAction('assistants:macros',async () => {
    for (const [key,method,img] of macros) {
      const command = `const text = key => game.i18n.localize('BOB.' + key);\nif (!game.user.isGM) return ui.notifications.warn(text('Common.GMOnly'));\nconst api = game.modules.get('${ID}')?.api;\nif (!api?.${method}) return ui.notifications.warn('Enable BoB Companion and reload.');\nawait api.${method}();`;
      const current = game.macros.find(macro=>macro.flags?.[ID]?.assistantMethod===method);
      const data = {name:t(key),type:'script',img,command,ownership:{default:0},flags:{[ID]:{assistantMethod:method}}};
      if (current) await current.update(data); else await Macro.create(data);
    }
    ui.notifications.info(t('Hub.MacrosReady'));
  });
}
let opening,activeWindow;
export function openAssistants() {
  if (opening) {activeWindow?.bringToFront();return opening;}
  opening=showAssistants().finally(()=>{opening=null;activeWindow=null;});
  return opening;
}
async function showAssistants() {
  if (!game.user?.isGM) throw new Error(t('Common.GMOnly'));
  class Hub extends foundry.applications.api.DialogV2 {
    async _onRender(context,options) {
      await super._onRender(context,options);
      this.element.addEventListener('click',async event => {
        const method=event.target.closest('[data-assistant]')?.dataset.assistant;
        if (!method||this.busy) return;
        try {
          this.busy=true;
          if (!game.user?.isGM) throw new Error(t('Common.GMOnly'));
          const api=game.modules.get(ID).api;
          if (typeof api[method]!=='function') throw new Error(t('Hub.NotReady'));
          await api[method]();
        } catch(error) {ui.notifications.error(error.message);}
        finally {this.busy=false;}
      });
    }
  }
  return Hub.wait({window:{title:`BoB | ${t('Hub.Title')}`},render:(_event,dialog)=>{activeWindow=dialog;},
    position:{width:520},classes:['bob-companion','bob-assistants'],
    content:`<div class="bob-tool-list">${entries.map(([method,label,hint])=>`<div><button type="button" data-assistant="${method}">${esc(t(label))}</button><p class="hint">${esc(t(hint))}</p></div>`).join('')}</div><details><summary>${t('Hub.Shortcuts')}</summary><p class="hint">${t('Hub.ShortcutsHint')}</p><button type="button" data-assistant="installAssistantMacros">${t('Hub.InstallMacros')}</button></details>`,
    buttons:[{action:'close',label:t('Common.Close')}]});
}
export function registerAssistants() {
  class Menu extends foundry.applications.api.ApplicationV2 {
    render() {void openAssistants().catch(error=>ui.notifications.error(error.message));return this;}
  }
  game.settings.registerMenu(ID,'assistants',{name:'BOB.Hub.Menu',label:'BOB.Hub.Open',hint:'BOB.Hub.Hint',icon:'fa-solid fa-book-open',type:Menu,restricted:true});
  Hooks.once('ready',()=>Object.assign(game.modules.get(ID).api??={}, {openAssistants,installAssistantMacros}));
}
