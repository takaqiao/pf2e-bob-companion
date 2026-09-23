import test from 'node:test';
import assert from 'node:assert/strict';

const adapter = await import('../scripts/calendar.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const areas = ['shore','grounds','cellars','reception','dungeon','private','temple','vault','towers'];
const clone = value => structuredClone(value);
function fixture() {
  assert.equal(typeof adapter.createCalendarController, 'function', 'calendar controller must be implemented');
  const f = {
    primary: true, forecastCleared: false, options: {enabled:true,hold:null}, saved: {},
    plan: {valid:true,chapter:6,zoneId:'bob-private',key:'6:rain',window:'rain',exception:false,
      weatherRequired:true,temperatureRequired:false,weather:{id:'bob-cold-rain',temperature:-4,wind:{speed:3,kph:50,direction:112.5,forced:false}}},
    calendar: {metadata:{id:'fixture'},weather:{activeZone:'bob-private'}},
    zones: areas.map(area=>({id:`bob-${area}`})),
    weather: {'bob-private':{id:'bob-cold-rain',temperature:-3,wind:{speed:3,kph:45,direction:90,forced:false},generated:true,setAt:100,setBy:'gm'}},
    writes: [], notifications: [],
    presets: ['clear','overcast','bob-cold-rain','bob-cold-overcast','bob-severe-thunderstorm'].map(id=>({id})),
    guards: {worldTime:123456,forecast:{a:1},history:{previous:1},scene:{weather:'bastion'},calendarLanguage:'zh-CN'}
  };
  f.api = {
    getActiveCalendar:()=>f.calendar,
    getCalendarZones:()=>f.zones,
    getCurrentWeather:zone=>clone(f.weather[zone]??null),
    getWeatherPresets:async()=>clone(f.presets),
    setActiveZone:async zone=>{ f.writes.push(['zone',zone]);f.calendar.weather.activeZone=zone;f.controller.weatherChanged({bulk:true}); },
    setWeather:async(id,options)=>{
      f.writes.push(['weather',id,clone(options)]);
      const current={id,temperature:options.temperature,wind:clone(options.wind),setAt:123456,setBy:'gm'};
      f.weather[options.zoneId]=current;
      f.controller.weatherChanged({current:clone(current),zoneId:options.zoneId});
      return clone(current);
    }
  };
  f.reconnect=()=> f.controller=adapter.createCalendarController({
    getAPI:()=>f.api,getPlan:()=>clone(f.plan),isPrimary:()=>f.primary,
    getOptions:()=>clone(f.options),saveOptions:async value=>{f.writes.push(['options',clone(value)]);f.options=clone(value);},
    getState:()=>clone(f.saved),saveState:async value=>{f.writes.push(['state',clone(value)]);f.saved=clone(value);},
    clearsForecast:()=>f.forecastCleared,keepForecast:async()=>{f.writes.push(['forecast-setting',false]);f.forecastCleared=false;},
    onStatus:value=>f.notifications.push(value)
  });
  f.reconnect();
  f.clear=()=>f.writes.length=0;
  return f;
}

test('optional integration and unsupported API remain read-only', async()=>{
  const f=fixture(); f.api=null;
  assert.equal((await f.controller.sync()).available,false);
  f.api={getActiveCalendar:()=>f.calendar};
  assert.equal((await f.controller.sync()).state,'unavailable');
  assert.deepEqual(f.writes,[]);
});

test('secondary GMs and players cannot write even via force or resume', async()=>{
  const f=fixture(); f.primary=false;
  await f.controller.sync({force:true});await f.controller.resume();await f.controller.hold();
  assert.deepEqual(f.writes,[]);
});

test('saved manual weather reasons follow the viewing client language without another write',async()=>{
  const prior=globalThis.game;
  let language='cn';
  globalThis.game={i18n:{format:key=>`${language}:${key}`}};
  try {
    const f=fixture();await f.controller.hold();f.clear();
    language='en';f.reconnect();
    assert.equal(f.controller.status().detail,'en:BOB.Calendar.HoldReason');
    assert.deepEqual(f.writes,[]);
    f.options.hold={until:'manual',reason:'GM custom reason'};
    assert.equal(f.controller.status().detail,'GM custom reason');
  } finally {globalThis.game=prior;}
});

test('daily generated weather remains variable and unchanged after reconnect', async()=>{
  const f=fixture();const before=clone(f.weather);
  await f.controller.sync();f.clear();
  for(let i=0;i<20;i++)await f.controller.sync();
  f.reconnect();await f.controller.sync();
  assert.deepEqual(f.weather,before);
  assert.deepEqual(f.writes,[]);
});

test('rain-break boundary writes once, retains wind and unrelated state', async()=>{
  const f=fixture();const before=clone(f.guards);await f.controller.sync();f.clear();
  f.plan={...f.plan,key:'6:break',window:'break',exception:true,weather:{...f.plan.weather,id:'bob-cold-overcast'}};
  await Promise.all(Array.from({length:20},()=>f.controller.sync()));
  assert.equal(f.weather['bob-private'].id,'bob-cold-overcast');
  assert.equal(f.weather['bob-private'].temperature,-3);
  assert.equal(f.weather['bob-private'].wind.direction,90);
  assert.equal(f.writes.filter(([kind])=>kind==='weather').length,1);
  assert.deepEqual(f.guards,before);
  f.clear();f.reconnect();await f.controller.sync();assert.deepEqual(f.writes,[]);
});

test('manual weather survives further ticks and boundaries until chapter changes', async()=>{
  const f=fixture();await f.controller.sync();f.clear();
  f.weather['bob-private']={id:'clear',temperature:10,wind:{speed:1},setAt:150,setBy:'other-gm'};
  await f.controller.weatherChanged({zoneId:'bob-private',current:clone(f.weather['bob-private'])});
  assert.equal(f.controller.status().state,'held');
  f.plan.key='6:break';f.plan.weather.id='bob-cold-overcast';
  await f.controller.sync();assert.equal(f.weather['bob-private'].id,'clear');
  f.plan={...f.plan,chapter:3,zoneId:'bob-cellars',key:'3:overcast',weather:{id:'overcast',temperature:7,wind:{speed:2}}};
  await f.controller.sync();
  assert.equal(f.calendar.weather.activeZone,'bob-cellars');
  assert.equal(f.weather['bob-cellars'].id,'overcast');
  assert.equal(f.options.hold,null);
});

test('existing manual weather on first enable is held and explicit resume applies current plan', async()=>{
  const f=fixture();f.weather['bob-private'].generated=false;f.weather['bob-private'].id='clear';
  await f.controller.sync();assert.equal(f.controller.status().state,'held');
  await f.controller.resume();assert.equal(f.weather['bob-private'].id,'bob-cold-rain');
  assert.equal(f.controller.status().state,'synced');
});

test('resuming already matching manual weather adopts it without rewriting or immediately holding again', async()=>{
  const f=fixture();f.weather['bob-private'].generated=false;
  await f.controller.sync();assert.equal(f.controller.status().state,'held');
  await f.controller.resume();f.clear();
  await f.controller.sync();f.reconnect();await f.controller.sync();
  assert.equal(f.controller.status().state,'synced');assert.equal(f.options.hold,null);
  assert.deepEqual(f.writes,[]);
});

test('manual zone changes are held without undoing the GM choice', async()=>{
  const f=fixture();await f.controller.sync();f.clear();
  f.calendar.weather.activeZone='bob-shore';
  await f.controller.weatherChanged({bulk:true});
  assert.equal(f.controller.status().state,'held');assert.equal(f.calendar.weather.activeZone,'bob-shore');
  assert.equal(f.writes.filter(([kind])=>kind==='zone').length,0);
});

test('a generated daily replacement inside a special window is corrected once without a hold', async()=>{
  const f=fixture();f.plan.weather.id='bob-cold-overcast';f.plan.exception=true;f.plan.key='6:break';
  await f.controller.sync();f.clear();
  f.weather['bob-private']={id:'bob-cold-rain',temperature:-5,wind:{speed:3,direction:60},generated:true,setAt:200,setBy:'gm'};
  await f.controller.weatherChanged({bulk:true});
  assert.equal(f.weather['bob-private'].id,'bob-cold-overcast');
  assert.equal(f.options.hold,null);
  assert.equal(f.writes.filter(([kind])=>kind==='weather').length,1);
});

test('missing chapter zones or required presets degrades without partial writes', async()=>{
  const f=fixture();f.zones=f.zones.slice(1);
  assert.equal((await f.controller.sync()).state,'degraded');assert.deepEqual(f.writes,[]);
  f.zones=areas.map(area=>({id:`bob-${area}`}));f.presets=[];
  assert.equal((await f.controller.sync()).state,'degraded');assert.deepEqual(f.writes,[]);
});

test('forecast-clearing API behavior blocks weather writes and never changes the setting', async()=>{
  const f=fixture();f.forecastCleared=true;f.plan.weather.id='bob-cold-overcast';
  assert.equal((await f.controller.sync()).state,'forecast-conflict');
  assert.deepEqual(f.writes,[]);assert.equal(f.forecastCleared,true);
});

test('explicit preparation preserves forecast contents and changes only the forecast behavior setting once', async()=>{
  const f=fixture();f.forecastCleared=true;f.options.enabled=false;f.plan.weather.id='bob-cold-overcast';
  const before=clone(f.guards);await f.controller.prepare();
  assert.equal(f.forecastCleared,false);assert.equal(f.options.enabled,true);
  assert.deepEqual(f.guards,before);assert.equal(f.weather['bob-private'].id,'bob-cold-overcast');
  await f.controller.prepare();assert.equal(f.writes.filter(([kind])=>kind==='forecast-setting').length,1);
});

test('preparation is read-only with missing prerequisites or a secondary GM', async()=>{
  const f=fixture();f.forecastCleared=true;f.zones=[];
  await f.controller.prepare();assert.deepEqual(f.writes,[]);
  f.zones=areas.map(area=>({id:`bob-${area}`}));f.primary=false;
  await f.controller.prepare();assert.deepEqual(f.writes,[]);
});

test('thermal band enforcement preserves daily variation already within the band', async()=>{
  const f=fixture();f.plan.temperatureRequired=true;f.plan.temperatureRange=[-6,-1];
  await f.controller.sync();assert.equal(f.weather['bob-private'].temperature,-3);
  f.weather['bob-private'].temperature=6;await f.controller.sync();
  assert.equal(f.weather['bob-private'].temperature,-4);
});

test('disabling integration or ending the storm never writes calendar data', async()=>{
  const f=fixture();f.options.enabled=false;await f.controller.sync({force:true});
  assert.deepEqual(f.writes,[]);
  f.options.enabled=true;f.plan={valid:false,reason:'风暴已停'};
  assert.equal((await f.controller.sync()).state,'paused');assert.deepEqual(f.writes,[]);
});

test('a chapter changed during an in-flight write is processed serially to the newest chapter', async()=>{
  const f=fixture();let release;const original=f.api.setWeather;
  const gate=new Promise(resolve=>{release=resolve;});let entered;
  const start=new Promise(resolve=>{entered=resolve;});
  f.api.setWeather=async(...args)=>{entered();await gate;return original(...args);};
  f.plan.weather.id='bob-cold-overcast';const first=f.controller.sync();await start;
  f.plan={...f.plan,chapter:3,zoneId:'bob-cellars',key:'3:overcast',weather:{id:'overcast',temperature:7,wind:{speed:2}}};
  const second=f.controller.sync();release();await Promise.all([first,second]);
  assert.equal(f.calendar.weather.activeZone,'bob-cellars');assert.equal(f.weather['bob-cellars'].id,'overcast');
  assert.equal(f.writes.filter(([kind])=>kind==='weather').length,2);
});

test('API failures report degradation without throwing from hooks and can be retried', async()=>{
  const f=fixture();f.plan.weather.id='bob-cold-overcast';const original=f.api.setWeather;
  f.api.setWeather=async()=>{throw new Error('transport failed');};
  assert.equal((await f.controller.sync()).state,'error');
  f.api.setWeather=original;
  assert.equal((await f.controller.sync({force:true})).state,'synced');
});

test('a generated intraday period is not mistaken for a manual override after a previous period correction', async()=>{
  const f=fixture();f.plan.weather.id='bob-cold-overcast';await f.controller.sync();
  f.weather['bob-private']={id:'bob-cold-rain',temperature:-3,wind:{speed:3},setAt:123456,setBy:'gm',
    activePeriod:'afternoon',periods:{afternoon:{id:'bob-cold-rain',temperature:-3,wind:{speed:3},generated:true,setAt:200,setBy:'gm'}}};
  await f.controller.weatherChanged({bulk:true});
  assert.equal(f.weather['bob-private'].id,'bob-cold-overcast');assert.equal(f.options.hold,null);
});

test('disabling integration during preset preflight prevents subsequent writes', async()=>{
  const f=fixture();let release,entered;const start=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  f.api.getWeatherPresets=async()=>{entered();await gate;return clone(f.presets);};
  f.plan.weather.id='bob-cold-overcast';const first=f.controller.sync();await start;
  f.options.enabled=false;release();await first;assert.deepEqual(f.writes,[]);
});

test('a changed calendar during preset preflight is validated before any writes', async()=>{
  const f=fixture();let release,entered;const start=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  f.api.getWeatherPresets=async()=>{entered();await gate;return clone(f.presets);};
  f.plan.weather.id='bob-cold-overcast';const first=f.controller.sync();await start;
  f.calendar={metadata:{id:'other-calendar'},weather:{activeZone:'natural'}};f.zones=[];
  release();await first;assert.deepEqual(f.writes,[]);assert.equal(f.controller.status().state,'degraded');
});

test('registered hooks skip ordinary seconds, respect designated GM authority and sync only a boundary', async t=>{
  const names=['game','Hooks','CALENDARIA','ATLAS'];
  const saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor] of saved) descriptor ? Object.defineProperty(globalThis,name,descriptor) : delete globalThis[name];});
  const f=fixture(),handlers=new Map(),id='pf2e-bob-companion',ownModule={};
  const settings=new Map([[`${id}.config`,{enabled:true,chapter:6,rain:'auto',phase:'auto',rainBreak:[780,870]}],
    ['calendaria.gmOverrideClearsForecast',false]]);
  const writes=[];let presetReads=0;
  globalThis.Hooks={on:(name,fn)=>{handlers.set(name,[...(handlers.get(name)??[]),fn]);},
    once:(name,fn)=>{handlers.set(name,[...(handlers.get(name)??[]),fn]);},
    callAll:(name,...args)=>{for(const fn of handlers.get(name)??[])fn(...args);}};
  globalThis.game={user:{id:'gm',isGM:true},users:{activeGM:{id:'gm'}},modules:new Map([[id,ownModule],['calendaria',{active:true}]]),
    pf2e:{worldClock:{worldTime:{isValid:true,hour:12,minute:0,second:0}}},
    get actors(){assert.fail('calendar hooks must never access actors');},
    get scenes(){assert.fail('calendar hooks must never access scenes');},
    settings:{register:(ns,key,definition)=>{if(!settings.has(`${ns}.${key}`))settings.set(`${ns}.${key}`,clone(definition.default));},
      get:(ns,key)=>settings.get(`${ns}.${key}`),set:async(ns,key,value)=>{writes.push([ns,key,clone(value)]);settings.set(`${ns}.${key}`,clone(value));Hooks.callAll('updateSetting',{key:`${ns}.${key}`});return value;}}};
  globalThis.ATLAS={isPrimaryGM:true};globalThis.CALENDARIA={api:{...f.api,
    getWeatherPresets:async()=>{presetReads++;return clone(f.presets);},
    setWeather:async(preset,options)=>{writes.push(['weather',preset]);f.weather[options.zoneId]={id:preset,...clone(options),setAt:200,setBy:'gm'};
      Hooks.callAll('calendaria.weatherChange',{current:f.weather[options.zoneId],zoneId:options.zoneId});return f.weather[options.zoneId];}}};
  const registered=await import(`../scripts/calendar.mjs?registration=${Date.now()}`);
  registered.registerCalendar();Hooks.callAll('ready');await ownModule.api.syncCalendar();writes.length=0;const before=presetReads;
  for(let second=1;second<60;second++){game.pf2e.worldClock.worldTime.second=second;Hooks.callAll('updateWorldTime');}
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(writes,[]);assert.equal(presetReads,before);
  ATLAS.isPrimaryGM=false;game.pf2e.worldClock.worldTime.hour=13;Hooks.callAll('updateWorldTime');await ownModule.api.syncCalendar({force:true});
  assert.deepEqual(writes,[]);
  ATLAS.isPrimaryGM=true;await ownModule.api.syncCalendar();
  assert.equal(f.weather['bob-private'].id,'bob-cold-overcast');
  assert.equal(writes.filter(([kind])=>kind==='weather').length,1);
  assert.equal(handlers.has('updateToken'),false);
});

test('a newer hold supersedes a queued force, and a later force supersedes an older hold', async()=>{
  const f=fixture();await f.controller.sync();
  await Promise.all([f.controller.sync({force:true}),f.controller.hold()]);
  assert.equal(f.controller.status().state,'held');assert.equal(f.options.hold?.until,'chapter');
  await Promise.all([f.controller.hold(),f.controller.sync({force:true})]);
  assert.equal(f.controller.status().state,'synced');assert.equal(f.options.hold,null);
});

test('a hold queued during preset preflight prevents the pending forced weather write', async()=>{
  const f=fixture();await f.controller.sync();f.clear();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.api.getWeatherPresets=async()=>{entered();await gate;return clone(f.presets);};
  f.plan.weather.id='bob-cold-overcast';const first=f.controller.sync({force:true});await started;
  const hold=f.controller.hold();release();await Promise.all([first,hold]);
  assert.equal(f.controller.status().state,'held');assert.equal(f.weather['bob-private'].id,'bob-cold-rain');
  assert.equal(f.writes.filter(([kind])=>kind==='weather').length,0);
});

test('remote manual weather arriving during a chapter zone write is held before any weather overwrite', async()=>{
  const f=fixture();f.saved={calendarId:'fixture',chapter:5,zoneId:'bob-dungeon',weather:null};f.calendar.weather.activeZone='bob-dungeon';
  f.plan.weather.id='bob-cold-overcast';
  f.api.setActiveZone=async zone=>{
    f.calendar.weather.activeZone=zone;
    f.weather[zone]={id:'clear',temperature:12,wind:{speed:0},setAt:300,setBy:'other-gm'};
    await f.controller.weatherChanged({remote:true,zoneId:zone,current:clone(f.weather[zone])});
  };
  await f.controller.sync();
  assert.equal(f.weather['bob-private'].id,'clear');assert.equal(f.controller.status().state,'held');
  assert.equal(f.writes.filter(([kind])=>kind==='weather').length,0);
});

test('remote wind-only edit during a weather write is held and never claimed as companion-owned', async()=>{
  const f=fixture();await f.controller.sync();f.clear();f.plan.weather.id='bob-cold-overcast';
  const native=f.api.setWeather;
  f.api.setWeather=async(...args)=>{
    const own=await native(...args);
    f.weather['bob-private']={...f.weather['bob-private'],wind:{speed:0},setAt:300,setBy:'other-gm'};
    await f.controller.weatherChanged({remote:true,zoneId:'bob-private',current:clone(f.weather['bob-private'])});
    return own;
  };
  await f.controller.sync();assert.equal(f.controller.status().state,'held');
  f.plan.key='6:later';f.plan.weather.id='bob-cold-rain';await f.controller.sync();
  assert.equal(f.weather['bob-private'].id,'bob-cold-overcast');assert.equal(f.weather['bob-private'].wind.speed,0);
  assert.equal(f.writes.filter(([kind])=>kind==='weather').length,1);
});

test('calendar switch or disable during a zone write prevents the following weather write', async()=>{
  for(const change of ['calendar','enabled','primary']) {
    const f=fixture();f.calendar.weather.activeZone='bob-dungeon';f.plan.weather.id='bob-cold-overcast';
    f.api.setActiveZone=async zone=>{
      f.calendar.weather.activeZone=zone;
      if(change==='calendar'){f.calendar={metadata:{id:'other'},weather:{activeZone:'natural'}};f.zones=[];}
      else if(change==='enabled')f.options.enabled=false;
      else f.primary=false;
    };
    await f.controller.sync();assert.equal(f.writes.filter(([kind])=>kind==='weather').length,0,change);
  }
});
