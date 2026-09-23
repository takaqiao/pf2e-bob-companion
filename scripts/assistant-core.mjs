import {t,localizeHTML} from './i18n.mjs';
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
  if(!globalThis.game?.user?.isGM)throw new Error(t('Common.GMOnly'));
  if(!isPrimaryGM())throw new Error(t('Common.PrimaryGM'));
}
export function now(){
  const time=globalThis.game?.time?.worldTime;
  if(!Number.isFinite(time))throw new Error(t('Common.ClockUnavailable'));
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
    if(typeof domain!=='string'||!domain||['__proto__','constructor','prototype'].includes(domain))throw new Error(t('Common.InvalidDomain'));
    const root=rootState(),draft=object(root[domain])?clone(root[domain]):{};
    const before=JSON.stringify(draft),result=mutator(draft);
    if(result&&typeof result.then==='function')throw new Error(t('Common.SyncUpdate'));
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
  if(!recipients.length)throw new Error(t('Common.NoGM'));
  return ChatMessage.create({content,flavor:localizeHTML('Common.Title'),whisper:recipients,style:globalThis.CONST?.CHAT_MESSAGE_STYLES?.OTHER??0});
}
export async function loadEffect(uuid){
  const document=await fromUuid(uuid);
  if(document?.type&&document.type!=='effect')throw new Error(t('Common.NotEffect'));
  if(typeof document?.toObject!=='function')throw new Error(t('Common.MissingEffect'));
  const data=clone(document.toObject());delete data._id;delete data.folder;delete data._stats;
  return data;
}
export function registerAssistantCore(){
  if(registered)return;registered=true;
  game.settings.register(ID,KEY,{name:t('Common.Records'),scope:'world',config:false,type:Object,default:{}});
}
