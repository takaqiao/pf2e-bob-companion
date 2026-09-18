import {ID, OFFICIAL, AREAS} from './model.mjs';
import {getEnvironment, DEFAULT_CONFIG} from './runtime.mjs';
import {calendarPlan} from './weather.mjs';

const METHODS = ['getActiveCalendar','getCalendarZones','getCurrentWeather','getWeatherPresets','setActiveZone','setWeather'];
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fingerprint = weather => weather ? JSON.stringify([weather.id,weather.temperature,weather.wind,
  weather.precipitation,weather.setAt,weather.setBy,weather.generated === true,weather.activePeriod]) : null;
// Native intraday transitions merge period fields but retain the outer generated flag.
const isGenerated = weather => (weather?.periods?.[weather.activePeriod] ?? weather)?.generated === true;
const labels = {unavailable:'未连接',disabled:'已停用',paused:'已暂停',waiting:'等待主 GM',held:'手动覆盖中',
  degraded:'需要配置', 'forecast-conflict':'需要保留预报',error:'同步失败',pending:'等待同步',synced:'同步正常'};

/** The injected seam covers only Calendaria API calls and our two owned settings.
 * A single queue serializes chapter changes, manual controls and native hooks. */
export function createCalendarController(deps) {
  let latest = {state:'pending',detail:'等待日历就绪。'};
  let inFlight, pending = false, forcePending = false, commandPending, writing = 0, published, activeWrite;

  function inspect() {
    const api = deps.getAPI();
    const available = Boolean(api && METHODS.every(name => typeof api[name] === 'function'));
    const options = {enabled:true,hold:null,...deps.getOptions()};
    const plan = deps.getPlan();
    const calendar = available ? api.getActiveCalendar() : null;
    return {api,available,options,plan,calendar};
  }

  function status() {
    try {
      const {available,options,plan,calendar,api} = inspect();
      let result = {...latest,available,enabled:options.enabled,zoneId:calendar?.weather?.activeZone ?? null,
        weatherId:available && calendar ? api.getCurrentWeather(calendar.weather?.activeZone)?.id ?? null : null};
      if (!available || !calendar) result = {...result,available:false,state:'unavailable',detail:'Calendaria 未启用、尚未就绪或缺少所需接口。'};
      else if (!options.enabled) result = {...result,state:'disabled',detail:'自动日历同步已停用。'};
      else if (!plan.valid) result = {...result,state:'paused',detail:plan.reason ?? '章节或时间不可用。'};
      else if (options.hold && (options.hold.until !== 'chapter' || options.hold.chapter === plan.chapter)) {
        result = {...result,state:'held',detail:options.hold.reason ?? '保留 GM 手动选择；可恢复自动同步。',
          overrideUntil:options.hold.until === 'chapter' ? '下次切章' : '手动恢复'};
      }
      return {...result,label:labels[result.state] ?? result.state};
    } catch (error) {
      return {available:false,enabled:false,state:'error',label:labels.error,detail:'无法读取日历状态。',
        zoneId:null,weatherId:null,error:String(error.message ?? error)};
    }
  }

  function report(state, detail, error) {
    latest = {state,detail,...(error ? {error:String(error.message ?? error)} : {})};
    const value = status();
    const key = JSON.stringify(value);
    if (key !== published) { published = key; deps.onStatus?.(value); }
    return value;
  }

  async function saveOptions(options) {
    if (!equal(options,deps.getOptions()) && deps.isPrimary()) await deps.saveOptions(options);
  }

  async function run(force, command) {
    let {api,available,options,plan,calendar} = inspect();
    if (!available || !calendar) return report('unavailable','Calendaria 未启用、尚未就绪或缺少所需接口。');
    if (!deps.isPrimary()) return report('waiting','由当前主 GM 执行自动同步。');
    if (!plan.valid) return report('paused',plan.reason ?? '章节或时间不可用。');
    if (!options.enabled && command?.type !== 'prepare') return report('disabled','自动日历同步已停用。');

    // Validate all installed zones before changing anything. Never rebuild calendars.
    const zones = api.getCalendarZones();
    const missing = AREAS.map(area => `bob-${area}`).filter(id => !zones?.some(zone => zone.id === id));
    if (missing.length) return report('degraded',`缺少既有章节日历区域：${missing.join('、')}。请恢复既有 BoB 日历配置后重试。`);
    const presets = await api.getWeatherPresets();
    if (!Array.isArray(presets) || !presets.some(preset => preset.id === plan.weather?.id)) {
      return report('degraded',`缺少既有天气预设 ${plan.weather?.id ?? ''}；请恢复既有 BoB 天气配置后重试。`);
    }
    if (!deps.isPrimary()) return report('waiting','主 GM 已变化，等待新主 GM 同步。');
    if (commandPending || forcePending) return status();
    // A newer chapter/configuration arriving during the async preflight wins.
    const fresh = inspect();
    if (fresh.plan.key !== plan.key || fresh.calendar?.metadata?.id !== calendar.metadata?.id) {
      pending = true;
      if (!commandPending && !forcePending) {forcePending = force;if (command) commandPending = command;}
      return status();
    }
    options = fresh.options;
    if (!options.enabled && command?.type !== 'prepare') return report('disabled','自动日历同步已停用。');

    if (command?.type === 'prepare') {
      // Deliberate GM action only: preserves forecast data, changes its override policy.
      if (deps.clearsForecast()) await deps.keepForecast();
      options = {...options,enabled:true,hold:null};
      await saveOptions(options);force = true;
    } else if (command?.type === 'hold') {
      options = {...options,hold:{until:command.until,chapter:plan.chapter,reason:'已暂停接管，保留 GM 手动天气与区域选择。'}};
      await saveOptions(options);
      return report('held','已暂停接管，保留 GM 手动选择。');
    } else if (command?.type === 'resume') force = true;

    const previous = deps.getState() ?? {};
    const calendarId = calendar.metadata?.id;
    const sameCalendar = previous.calendarId === calendarId;
    const chapterChanged = sameCalendar && Number.isInteger(previous.chapter) && previous.chapter !== plan.chapter;
    const holdExpired = options.hold?.until === 'chapter' && options.hold.chapter !== plan.chapter;
    if ((force || holdExpired) && options.hold) {
      options = {...options,hold:null};await saveOptions(options);
    }
    if (options.hold) return report('held','保留 GM 手动选择；到期或恢复自动后继续同步。');

    calendar = api.getActiveCalendar();
    const activeZone = calendar.weather?.activeZone;
    const current = api.getCurrentWeather(plan.zoneId);
    const owned = sameCalendar && previous.zoneId === plan.zoneId && previous.weather === fingerprint(current);
    const manualWeather = current && !isGenerated(current) && !owned && activeZone === plan.zoneId;
    const manualZone = sameCalendar && previous.zoneId && activeZone !== previous.zoneId;
    if (!force && !chapterChanged && !holdExpired && (manualWeather || manualZone)) {
      await saveOptions({...options,hold:{until:'chapter',chapter:plan.chapter,
        reason:'检测到手动天气或区域选择；保留至下次切章，也可立即恢复自动。'}});
      return report('held','保留 GM 手动选择。');
    }

    const range = plan.temperatureRange;
    const wrongTemperature = plan.temperatureRequired && (!Number.isFinite(current?.temperature)
      || (Array.isArray(range) ? current.temperature < range[0] || current.temperature > range[1]
        : current.temperature !== plan.weather.temperature));
    const changeWeather = !current || (plan.weatherRequired && current.id !== plan.weather.id) || wrongTemperature;
    if (changeWeather && deps.clearsForecast()) return report('forecast-conflict',
      'Calendaria 当前会在手动改天气时重建预报。请使用“启用自动同步并保留预报”，保留现有预报后再同步。');

    let applied = previous.weather ?? null;
    const stillCurrent = () => {
      const fresh = inspect();
      if (!deps.isPrimary() || !fresh.options.enabled || fresh.plan.key !== plan.key
        || fresh.calendar?.metadata?.id !== calendarId || commandPending || forcePending) {
        pending = true;return false;
      }
      return true;
    };
    const holdExternal = async () => {
      await saveOptions({...deps.getOptions(),hold:{until:'chapter',chapter:plan.chapter,
        reason:'同步期间检测到手动天气修改；保留至下次切章，也可恢复自动。'}});
      return report('held','保留同步期间的 GM 手动修改。');
    };
    activeWrite = {zoneId:plan.zoneId,expected:null,manual:false};
    writing++;
    try {
      if (activeZone !== plan.zoneId) {
        if (!stillCurrent()) return status();
        await api.setActiveZone(plan.zoneId);
        if (!stillCurrent()) return status();
        const freshWeather = api.getCurrentWeather(plan.zoneId);
        if (activeWrite.manual || (fingerprint(freshWeather) !== fingerprint(current) && !isGenerated(freshWeather))) {
          return await holdExternal();
        }
        if (api.getActiveCalendar()?.weather?.activeZone !== plan.zoneId) throw new Error('日历未接受章节区域切换。');
      }
      if (changeWeather) {
        if (!stillCurrent()) return status();
        const id = plan.weatherRequired || !current ? plan.weather.id : current.id;
        const temperature = wrongTemperature || !current ? plan.weather.temperature : current.temperature;
        const wind = current?.wind ?? plan.weather.wind;
        activeWrite.expected = {id,temperature,wind};
        const written = await api.setWeather(id,{zoneId:plan.zoneId,temperature,wind});
        if (!stillCurrent()) return status();
        const after = api.getCurrentWeather(plan.zoneId);
        if (activeWrite.manual || (written && fingerprint(written) !== fingerprint(after) && !isGenerated(after))) {
          return await holdExternal();
        }
        if (after?.id !== id || after?.temperature !== temperature) throw new Error('日历未接受天气更新。');
        applied = fingerprint(after);
      }
    } finally { writing--;activeWrite = undefined; }
    const accepted = changeWeather ? applied : force || chapterChanged || holdExpired || activeZone !== plan.zoneId
      ? fingerprint(api.getCurrentWeather(plan.zoneId)) : sameCalendar && previous.zoneId === plan.zoneId ? applied : null;
    const next = {calendarId,chapter:plan.chapter,zoneId:plan.zoneId,key:plan.key,weather:accepted};
    if (!equal(previous,next) && deps.isPrimary()) await deps.saveState(next);
    return report('synced',`第 ${plan.chapter} 章 · ${plan.window}；每日天气由 Calendaria 生成。`);
  }

  function enqueue({force = false,command} = {}) {
    pending = true;
    // Explicit controls are ordered: a newer hold defeats an older force, and vice versa.
    if (command) {commandPending = command;forcePending = false;}
    else if (force) {forcePending = true;commandPending = undefined;}
    if (!inFlight) inFlight = Promise.resolve().then(async () => {
      while (pending) {
        pending = false;
        const forced = forcePending, action = commandPending;forcePending = false;commandPending = undefined;
        try { await deps.whenWeatherSettled?.();await run(forced,action); }
        catch (error) { report('error','日历同步失败；保留当前数据，可重试。',error); }
      }
      return status();
    }).finally(() => {inFlight = undefined;});
    return inFlight;
  }
  return {status,sync:enqueue,
    resume:() => enqueue({command:{type:'resume'}}),
    hold:({until='chapter'}={}) => enqueue({command:{type:'hold',until:until === 'chapter' ? 'chapter' : 'manual'}}),
    prepare:() => enqueue({command:{type:'prepare'}}),
    weatherChanged:(data={}) => {
      if (!writing) return enqueue();
      pending = true;
      const current = data.current, expected = activeWrite?.expected;
      if (data.zoneId === activeWrite?.zoneId && current && !isGenerated(current)
        && (data.remote || !expected || current.id !== expected.id || current.temperature !== expected.temperature
          || !equal(current.wind,expected.wind))) activeWrite.manual = true;
      // Native hooks can fire inside an awaited API write; never wait on our own queue here.
      return Promise.resolve(status());
    }};
}

let controller, registered = false, lastClockKey;
const readSetting = (key,fallback) => {try {return game.settings.get(ID,key) ?? fallback;} catch {return fallback;}};
const primaryGM = () => Boolean(globalThis.game?.user?.isGM &&
  (typeof globalThis.ATLAS?.isPrimaryGM === 'boolean' ? ATLAS.isPrimaryGM : game.users?.activeGM?.id === game.user.id));

function currentPlan() {
  const config = {...DEFAULT_CONFIG,...readSetting('config',{})};
  if (!config.enabled) return {valid:false,reason:'伴随模组已停用，日历自动同步暂停。'};
  return calendarPlan({environment:getEnvironment(),config});
}

function getController() {
  return controller ??= createCalendarController({
    getAPI:() => game.modules.get('calendaria')?.active ? globalThis.CALENDARIA?.api : null,
    getPlan:currentPlan,isPrimary:primaryGM,
    getOptions:() => readSetting('calendar',{enabled:true,hold:null}),
    saveOptions:value => game.settings.set(ID,'calendar',value),
    getState:() => readSetting('calendarState',{}),saveState:value => game.settings.set(ID,'calendarState',value),
    clearsForecast:() => game.settings.get('calendaria','gmOverrideClearsForecast') !== false,
    keepForecast:() => game.settings.set('calendaria','gmOverrideClearsForecast',false),
    whenWeatherSettled:() => globalThis.CALENDARIA?.managers?.WeatherManager?.whenDayChangeSettled?.(),
    onStatus:value => Hooks.callAll(`${ID}.calendar`,value)
  });
}

export const getCalendarStatus = () => getController().status();
export const syncCalendar = options => getController().sync(options);
export const resumeCalendar = () => getController().resume();
export const holdCalendar = options => getController().hold(options);
export const prepareCalendar = () => getController().prepare();

export function registerCalendar() {
  if (registered) return;
  registered = true;
  game.settings.register(ID,'calendar',{name:'BoB 日历同步',scope:'world',config:false,type:Object,
    default:{enabled:true,hold:null}});
  game.settings.register(ID,'calendarState',{name:'BoB 日历同步记录',scope:'world',config:false,type:Object,default:{}});
  const module = game.modules.get(ID);
  if (module) module.api = {...module.api,calendarStatus:getCalendarStatus,getCalendarStatus,syncCalendar,resumeCalendar,holdCalendar,prepareCalendar};
  const sync = () => {lastClockKey = currentPlan().key;void syncCalendar();};
  Hooks.once('ready',sync);
  for (const hook of ['calendaria.ready','calendaria.calendarSwitched','calendaria.calendarUpdated','userConnected']) Hooks.on(hook,sync);
  Hooks.on('updateUser',(_user,changes) => {if ('active' in changes || 'role' in changes) sync();});
  Hooks.on('updateWorldTime',() => {if (currentPlan().key !== lastClockKey) sync();});
  Hooks.on('calendaria.weatherChange',data => {void getController().weatherChanged(data);});
  Hooks.on('updateSetting',setting => {
    if ([`${OFFICIAL}.campaign`,`${ID}.config`,`${ID}.calendar`,'pf2e.worldClock',
      'calendaria.gmOverrideClearsForecast','calendaria.customWeatherPresets'].includes(setting.key)) sync();
  });
}
