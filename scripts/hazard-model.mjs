const PERIOD=600,IMMUNITY=8*3600;
const inside=(s,actor,field)=>Object.values(s.tokens??{}).some(t=>t.actorUuid===actor&&t[field]);
function clock(s,time){
  const c=s.lightning;if(!c)return;
  const elapsed=c.elapsed+(c.started===null?0:Math.max(0,time-c.started));
  const periods=Math.floor(elapsed/PERIOD),due=Math.max(0,periods-c.notified);
  if(due){s.requests??={};const old=s.requests.lightning;s.requests.lightning={kind:'lightning',count:(old?.count??0)+due,at:old?.at??time};c.notified=periods;}
  const running=!s.stormEnded&&!s.paused&&Object.values(s.tokens??{}).some(t=>t.inTower);
  if(!running&&c.started!==null){c.elapsed=elapsed;c.started=null;}
  else if(running&&c.started===null)c.started=time;
}
export function advanceHazards(s,time,options={}){
  if(!Number.isFinite(time))throw new Error('世界时间无效。');
  if(Object.hasOwn(options,'stormEnded')&&s.stormEnded!==!!options.stormEnded)s.stormEnded=!!options.stormEnded;
  if(Object.hasOwn(options,'enabled')&&s.paused!==!options.enabled)s.paused=!options.enabled;
  clock(s,time);
  for(const [id,actor] of Object.entries(s.actors??{}))if(actor.immune&&actor.outsideSince!==null&&time-actor.outsideSince>IMMUNITY&&!inside(s,id,'inDungeon')){actor.immune=false;actor.outsideSince=null;}
  return s;
}
export function requestFoul(s,actorUuid,time,trigger){
  const actor=s.actors?.[actorUuid];
  if(!actor||actor.immune||!inside(s,actorUuid,'inFoul')||actor.lastFoulTrigger===trigger)return;
  actor.lastFoulTrigger=trigger;s.requests??={};
  s.requests[`foul:${actorUuid}`]??={kind:'foul',actorUuid,at:time};
}
function reconcileActor(s,id,time,wasInDungeon){
  const actor=s.actors?.[id];if(!actor)return;
  const inDungeon=inside(s,id,'inDungeon');
  if(inDungeon&&actor.outsideSince!==null)actor.outsideSince=null;
  else if(wasInDungeon&&!inDungeon&&actor.immune&&actor.outsideSince===null)actor.outsideSince=time;
}
export function setMembership(s,token,time){
  const types=new Set(token.types??[]),prior=s.tokens?.[token.tokenUuid];
  const next={actorUuid:token.actorUuid,sceneId:token.sceneId,name:token.name,inDungeon:types.has('dungeon')||types.has('foul'),inFoul:types.has('foul'),inTower:types.has('tower')};
  if(!prior&&!next.inDungeon&&!next.inTower)return s;
  if(prior&&JSON.stringify(prior)===JSON.stringify(next))return s;
  advanceHazards(s,time);
  const wasInDungeon=inside(s,token.actorUuid,'inDungeon'),wasInFoul=inside(s,token.actorUuid,'inFoul');
  const oldWasInDungeon=prior&&inside(s,prior.actorUuid,'inDungeon');
  s.tokens??={};s.actors??={};s.requests??={};
  s.actors[token.actorUuid]??={immune:false,outsideSince:null};
  if(next.inDungeon||next.inTower)s.tokens[token.tokenUuid]=next;else delete s.tokens[token.tokenUuid];
  reconcileActor(s,token.actorUuid,time,wasInDungeon);
  if(prior&&prior.actorUuid!==token.actorUuid)reconcileActor(s,prior.actorUuid,time,oldWasInDungeon);
  if(next.inTower&&!s.lightning)s.lightning={elapsed:0,started:null,notified:0};
  clock(s,time);
  if(!wasInFoul&&inside(s,token.actorUuid,'inFoul')){
    const actor=s.actors[token.actorUuid];actor.entries=(actor.entries??0)+1;
    requestFoul(s,token.actorUuid,time,`entry:${token.tokenUuid}:${actor.entries}`);
  }
  return s;
}
export function removeTrackedToken(s,tokenUuid,time){
  const prior=s.tokens?.[tokenUuid];if(!prior)return s;
  advanceHazards(s,time);const was=inside(s,prior.actorUuid,'inDungeon');delete s.tokens[tokenUuid];
  reconcileActor(s,prior.actorUuid,time,was);clock(s,time);return s;
}
export function resolveFoul(s,actorUuid,success,time=0){
  if(!s.actors?.[actorUuid])return;
  if(success){s.actors[actorUuid].immune=true;s.actors[actorUuid].outsideSince=inside(s,actorUuid,'inDungeon')?null:time;}
  if(s.requests)delete s.requests[`foul:${actorUuid}`];
}
export function resolveLightning(s){if(s.requests)delete s.requests.lightning;}
