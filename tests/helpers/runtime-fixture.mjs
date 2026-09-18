import assert from 'node:assert/strict';

let sequence = 0;
export const ID = 'pf2e-bob-companion';
export const MAIN = 'z8wkbcziQufR7jWG';

/** Native Foundry documents need a browser/server; exercise the real runtime and
 * hook registrations with document preparation and timer boundaries replaced. */
export async function runtimeFixture(t) {
  const globals = ['game','Hooks','CONFIG','libWrapper','ui','setTimeout','clearTimeout'];
  const saved = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(() => { for (const key of globals) saved[key] ? Object.defineProperty(globalThis,key,saved[key]) : delete globalThis[key]; });
  const handlers = new Map(), timers = new Map();
  let timerId = 0, wrapper, registration;
  const calls = {reset:[],render:[],actorReads:[],errors:[]};
  const cfg = {enabled:true,chapter:9,phase:'auto',rain:'auto',rainBreak:[780,870],weather:true,stormEnded:false};
  const collection = rows => Object.assign(rows,{get(id){return this.find(row => row.id === id);}});
  globalThis.setTimeout = (fn, delay) => { assert.equal(delay,50); const id=++timerId; timers.set(id,fn); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.Hooks = {
    on(name,fn){ const rows=handlers.get(name)??[]; rows.push({fn,once:false}); handlers.set(name,rows); },
    once(name,fn){ const rows=handlers.get(name)??[]; rows.push({fn,once:true}); handlers.set(name,rows); },
    callAll(name,...args){ for(const row of [...(handlers.get(name)??[])]) {
      if(row.once) handlers.set(name,handlers.get(name).filter(other => other!==row)); row.fn(...args);
    } }
  };
  globalThis.libWrapper = {register(_id,_target,fn){wrapper=fn;}};
  globalThis.ui = {notifications:{warn(){},error(message){calls.errors.push(message);}}};
  globalThis.CONFIG = {PF2E:{Item:{documentClasses:{effect:class {
    constructor(source,{parent}){this.source=source;this.parent=parent;}
    prepareRuleElements(){return this.source.system.rules.map(rule => ({...rule,priority:100,ignored:false,invalid:false,item:this}));}
  }}}}};
  const makeScene = (id,flags={}) => ({id,flags:{[ID]:flags},tokens:collection([])});
  const main = makeScene(MAIN,{exposure:'outdoors'});
  const remote = makeScene('remote',{scope:'include',exposure:'outdoors'});
  const other = makeScene('other');
  const actors=collection([]),scenes=collection([main,remote,other]);scenes.active=main;
  const sky={id:'sky',system:{slug:'effect-the-skies-above-chapter-9'}};
  const makeActor = (id,isToken=false) => ({
    id,uuid:isToken?`Scene.${id}.Token.${id}.Actor.${id}`:`Actor.${id}`,type:isToken?'npc':'character',isToken,
    flags:{},items:[sky],hasPlayerOwner:!isToken,system:{details:{alliance:isToken?'opposition':'party'},traits:{value:[]}},
    original:[{key:'FlatModifier',slug:'official-weather',selector:['perception'],value:-9,priority:100,item:sky}],
    prepared:[],
    reset(){calls.reset.push(this.id);this.prepared=wrapper.call(this,()=>this.original);},
    render(force){assert.equal(force,false);calls.render.push(this.id);}
  });
  const a=makeActor('a'),b=makeActor('b'),s=makeActor('s',true),r=makeActor('r',true);
  actors.push(a,b);
  const makeToken = (id,actor,actorLink,parent) => {
    const token={id,actorId:actor?.id,actorLink,parent,disposition:actorLink?1:-1,flags:{},regions:[],hasConstructedActor:Boolean(actor),syntheticActor:actorLink?null:actor,
      get actor(){calls.actorReads.push(id);const owner=this.actorLink?actors.get(this.actorId):this.syntheticActor;assert.ok(owner,'must not construct a synthetic actor');return owner;}};
    if(actor?.isToken) actor.token=token;
    parent.tokens.push(token);return token;
  };
  const ta=makeToken('ta',a,true,main),tb=makeToken('tb',b,true,main);
  const ts=makeToken('ts',s,false,main),tr=makeToken('tr',r,false,remote);
  makeToken('unconstructed',null,false,remote);
  globalThis.game={ready:true,system:{id:'pf2e'},user:{isGM:true},modules:new Map([[ID,{}]]),actors,scenes,
    pf2e:{worldClock:{worldTime:{isValid:true,hour:23,minute:0,second:0}}},
    settings:{get(namespace,key){if(namespace===ID&&key==='config')return cfg;throw new Error(`${namespace}.${key}`);},
      register(_namespace,_key,value){registration=value;}}
  };
  const runtime=await import(`../../scripts/runtime.mjs?runtime-test=${++sequence}`);
  runtime.registerRuntime();Hooks.callAll('ready');
  const clear=()=>{for(const list of Object.values(calls))list.length=0;};
  const flush=()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();assert.deepEqual(calls.errors,[]);};
  const updateToken=(token,changes)=>{Object.assign(token,changes);Hooks.callAll('updateToken',token,changes);flush();};
  const configure=changes=>{Object.assign(cfg,changes);registration.onChange(cfg);flush();};
  const emit=(name,...args)=>{Hooks.callAll(name,...args);flush();};
  const slugs=actor=>actor.prepared.map(rule=>rule.slug).filter(Boolean);
  clear();
  return {runtime,calls,cfg,actors,scenes,main,remote,other,a,b,s,r,ta,tb,ts,tr,makeActor,makeToken,clear,flush,updateToken,configure,emit,slugs};
}
