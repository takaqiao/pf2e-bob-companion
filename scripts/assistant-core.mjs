import {ID} from './model.mjs';

const KEY='assistantState';
const clone=value=>structuredClone(value);
const queues=new Map();
let writeQueue=Promise.resolve();
let registered=false;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

export function isPrimaryGM(){
  const game=globalThis.game;
  if(!game?.user?.isGM)return false;
  const primary=game.users?.activeGM??Array.from(game.users??[]).filter(u=>u.isGM&&u.active).sort((a,b)=>String(a.id).localeCompare(String(b.id)))[0];
  return primary?.id===game.user.id;
}
export function requirePrimaryGM(){
  if(!globalThis.game?.user?.isGM)throw new Error('冒险助手仅供 GM 使用。');
  if(!isPrimaryGM())throw new Error('请由当前主 GM 执行结算，避免重复记录。');
}
export function now(){
  const time=globalThis.game?.time?.worldTime;
  if(!Number.isFinite(time))throw new Error('世界时间不可用，暂不能结算。');
  return time;
}
export function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function partyMembers(){
  const members=globalThis.game?.actors?.party?.members;
  return Array.from(members??globalThis.game?.actors??[]).filter(actor=>actor.type==='character'&&(members||actor.hasPlayerOwner));
}
function rootState(){const state=game.settings.get(ID,KEY);return object(state)?clone(state):{};}
export function readState(domain){
  const value=rootState()[domain];
  return object(value)?value:{};
}
export function updateState(domain,mutator){
  const task=writeQueue.catch(()=>{}).then(async()=>{
    requirePrimaryGM();
    if(typeof domain!=='string'||!domain||['__proto__','constructor','prototype'].includes(domain))throw new Error('记录类别无效。');
    const root=rootState(),draft=object(root[domain])?clone(root[domain]):{};
    const before=JSON.stringify(draft),result=mutator(draft);
    if(result&&typeof result.then==='function')throw new Error('记录更新必须同步完成。');
    if(JSON.stringify(draft)!==before){
      requirePrimaryGM();
      root[domain]=draft;
      await game.settings.set(ID,KEY,root);
      globalThis.Hooks?.callAll?.(`${ID}.assistant`,domain);
    }
    return clone(draft);
  });
  writeQueue=task.catch(()=>{});
  return task;
}
export function withAction(key,task){
  const action=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(()=>{requirePrimaryGM();return task();});
  const tail=action.catch(()=>{});
  queues.set(key,tail);
  void tail.finally(()=>{if(queues.get(key)===tail)queues.delete(key);});
  return action;
}
export async function whisperGM(content){
  requirePrimaryGM();
  const recipients=Array.from(game.users??[]).filter(user=>user.isGM).map(user=>user.id);
  if(!recipients.length)throw new Error('没有可接收待办的 GM。');
  return ChatMessage.create({content,flavor:'BoB｜冒险助手',whisper:recipients,style:globalThis.CONST?.CHAT_MESSAGE_STYLES?.OTHER??0});
}
export async function loadEffect(uuid){
  const document=await fromUuid(uuid);
  if(document?.type&&document.type!=='effect')throw new Error('规则来源不是效果。');
  if(typeof document?.toObject!=='function')throw new Error('所需的原生效果不可用，请检查冒险模块。');
  const data=clone(document.toObject());delete data._id;delete data.folder;delete data._stats;
  return data;
}
export function registerAssistantCore(){
  if(registered)return;registered=true;
  game.settings.register(ID,KEY,{name:'冒险助手记录',scope:'world',config:false,type:Object,default:{}});
}
