import {ID} from './model.mjs';
import {requirePrimaryGM,escapeHtml as esc,withAction} from './assistant-core.mjs';
const entries=[['openNightmares','休息与噩梦','确认本次实际休息成员，处理休息后的检定。'],['openBoons','恩惠与冷却','当前地点的恩惠、使用记录与冷却。'],['openHazards','环境危险','区域暴露、待处理检定与时间累计。'],['openSoulhearts','魂心','选择持有者与用途，预览后结算。']];
const macroDefinitions=[['冒险助手','openAssistants','icons/sundries/books/book-symbol-eye-purple.webp'],['使用魂心','openSoulhearts','icons/commodities/gems/gem-faceted-round-purple.webp']];
export async function installAssistantMacros(){
  return withAction('assistants:macros',async()=>{
    for(const [name,method,img] of macroDefinitions){
      const command=`if (!game.user.isGM) return ui.notifications.warn('此入口仅供 GM 使用。');\nconst api = game.modules.get('${ID}')?.api;\nif (!api?.${method}) return ui.notifications.warn('请启用 BoB 伴随模组并刷新页面。');\nawait api.${method}();`;
      const current=game.macros.find(m=>m.flags?.[ID]?.assistantMethod===method);
      const data={name,type:'script',img,command,ownership:{default:0},flags:{[ID]:{assistantMethod:method}}};
      if(current)await current.update(data);else await Macro.create(data);
    }
    ui.notifications.info('两个 GM 宏已就绪，可从宏目录拖到空闲快捷栏。');
  });
}
let opening,activeWindow;
export function openAssistants(){
  if(opening){activeWindow?.bringToFront();return opening;}
  opening=showAssistants().finally(()=>{opening=null;activeWindow=null;});return opening;
}
async function showAssistants(){
  if(!game.user?.isGM)throw new Error('冒险助手仅供 GM 使用。');
  class Hub extends foundry.applications.api.DialogV2 {
    async _onRender(context,options){await super._onRender(context,options);this.element.addEventListener('click',async event=>{
      const method=event.target.closest('[data-assistant]')?.dataset.assistant;if(!method||this.busy)return;
      try{this.busy=true;if(!game.user?.isGM)throw new Error('冒险助手仅供 GM 使用。');const api=game.modules.get(ID).api;if(typeof api[method]!=='function')throw new Error('入口尚未就绪，请刷新页面。');await api[method]();}catch(error){ui.notifications.error(error.message);}finally{this.busy=false;}
    });}
  }
  return Hub.wait({window:{title:'BoB｜冒险助手'},render:(_event,dialog)=>{activeWindow=dialog;},position:{width:540},classes:['bob-companion','bob-assistants'],content:`<p>主 GM 使用。研究继续沿用已有场景；玩家只接收当前结算结果。</p><div class="bob-assistant-grid">${entries.map(([method,label,hint])=>`<article><button type="button" data-assistant="${method}">${esc(label)}</button><p>${esc(hint)}</p></article>`).join('')}</div><details><summary>快捷入口</summary><p>创建两个仅 GM 可见的宏，不占用现有快捷栏。</p><button type="button" data-assistant="installAssistantMacros">安装／更新快捷宏</button></details>`,buttons:[{action:'close',label:'关闭'}]});
}
export function registerAssistants(){
  class Menu extends foundry.applications.api.ApplicationV2{render(){void openAssistants().catch(error=>ui.notifications.error(error.message));return this;}}
  game.settings.registerMenu(ID,'assistants',{name:'BoB 冒险助手',label:'打开冒险助手',hint:'休息、恩惠、环境危险与魂心。',icon:'fa-solid fa-book-open',type:Menu,restricted:true});
  Hooks.once('ready',()=>Object.assign(game.modules.get(ID).api??={}, {openAssistants,installAssistantMacros}));
}
