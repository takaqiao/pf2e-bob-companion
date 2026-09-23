import {t} from './i18n.mjs';
import {ID, OFFICIAL, AREAS} from './model.mjs';
import {getEnvironment, DEFAULT_CONFIG} from './runtime.mjs';
import {calendarPlan} from './weather.mjs';

const METHODS = ['getActiveCalendar','getCalendarZones','getCurrentWeather','getWeatherPresets','setActiveZone','setWeather'];
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fingerprint = weather => weather ? JSON.stringify([weather.id,weather.temperature,weather.wind,
  weather.precipitation,weather.setAt,weather.setBy,weather.generated === true,weather.activePeriod]) : null;
// Native intraday transitions merge period fields but retain the outer generated flag.
const isGenerated = weather => (weather?.periods?.[weather.activePeriod] ?? weather)?.generated === true;
const labels = () => ({unavailable:t('Calendar.Unavailable'),disabled:t('Calendar.Disabled'),paused:t('Calendar.Paused'),waiting:t('Calendar.Waiting'),held:t('Calendar.Held'),
  degraded:t('Calendar.Degraded'), 'forecast-conflict':t('Calendar.ForecastConflict'),error:t('Calendar.Error'),pending:t('Calendar.Pending'),synced:t('Calendar.Synced')});

/** The injected seam covers only Calendaria API calls and our two owned settings.
 * A single queue serializes chapter changes, manual controls and native hooks. */
export function createCalendarController(deps) {
  let latest = {state:'pending',detail:t('Calendar.WaitReady')};
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
      if (!available || !calendar) result = {...result,available:false,state:'unavailable',detail:t('Calendar.NoAPI')};
      else if (!options.enabled) result = {...result,state:'disabled',detail:t('Calendar.SyncDisabled')};
      else if (!plan.valid) result = {...result,state:'paused',detail:plan.reason ?? t('Calendar.InvalidTime')};
      else if (options.hold && (options.hold.until !== 'chapter' || options.hold.chapter === plan.chapter)) {
        result = {...result,state:'held',detail:options.hold.reasonKey ? t(options.hold.reasonKey) : options.hold.reason ?? t('Calendar.KeepManual'),
          overrideUntil:options.hold.until === 'chapter' ? t('Calendar.NextChapter') : t('Calendar.ManualResume')};
      }
      return {...result,label:labels()[result.state] ?? result.state};
    } catch (error) {
      return {available:false,enabled:false,state:'error',label:labels().error,detail:t('Calendar.ReadFailed'),
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
    if (!available || !calendar) return report('unavailable',t('Calendar.NoAPI'));
    if (!deps.isPrimary()) return report('waiting',t('Calendar.PrimaryOnly'));
    if (!plan.valid) return report('paused',plan.reason ?? t('Calendar.InvalidTime'));
    if (!options.enabled && command?.type !== 'prepare') return report('disabled',t('Calendar.SyncDisabled'));

    // Validate all installed zones before changing anything. Never rebuild calendars.
    const zones = api.getCalendarZones();
    const missing = AREAS.map(area => `bob-${area}`).filter(id => !zones?.some(zone => zone.id === id));
    if (missing.length) return report('degraded',t('Calendar.MissingZones',{zones:missing.join(', ')}));
    const presets = await api.getWeatherPresets();
    if (!Array.isArray(presets) || !presets.some(preset => preset.id === plan.weather?.id)) {
      return report('degraded',t('Calendar.MissingPreset',{preset:plan.weather?.id ?? ''}));
    }
    if (!deps.isPrimary()) return report('waiting',t('Calendar.PrimaryChanged'));
    if (commandPending || forcePending) return status();
    // A newer chapter/configuration arriving during the async preflight wins.
    const fresh = inspect();
    if (fresh.plan.key !== plan.key || fresh.calendar?.metadata?.id !== calendar.metadata?.id) {
      pending = true;
      if (!commandPending && !forcePending) {forcePending = force;if (command) commandPending = command;}
      return status();
    }
    options = fresh.options;
    if (!options.enabled && command?.type !== 'prepare') return report('disabled',t('Calendar.SyncDisabled'));

    if (command?.type === 'prepare') {
      // Deliberate GM action only: preserves forecast data, changes its override policy.
      if (deps.clearsForecast()) await deps.keepForecast();
      options = {...options,enabled:true,hold:null};
      await saveOptions(options);force = true;
    } else if (command?.type === 'hold') {
      options = {...options,hold:{until:command.until,chapter:plan.chapter,reasonKey:'Calendar.HoldReason'}};
      await saveOptions(options);
      return report('held',t('Calendar.HoldStatus'));
    } else if (command?.type === 'resume') force = true;

    const previous = deps.getState() ?? {};
    const calendarId = calendar.metadata?.id;
    const sameCalendar = previous.calendarId === calendarId;
    const chapterChanged = sameCalendar && Number.isInteger(previous.chapter) && previous.chapter !== plan.chapter;
    const holdExpired = options.hold?.until === 'chapter' && options.hold.chapter !== plan.chapter;
    if ((force || holdExpired) && options.hold) {
      options = {...options,hold:null};await saveOptions(options);
    }
    if (options.hold) return report('held',t('Calendar.HoldUntil'));

    calendar = api.getActiveCalendar();
    const activeZone = calendar.weather?.activeZone;
    const current = api.getCurrentWeather(plan.zoneId);
    const owned = sameCalendar && previous.zoneId === plan.zoneId && previous.weather === fingerprint(current);
    const manualWeather = current && !isGenerated(current) && !owned && activeZone === plan.zoneId;
    const manualZone = sameCalendar && previous.zoneId && activeZone !== previous.zoneId;
    if (!force && !chapterChanged && !holdExpired && (manualWeather || manualZone)) {
      await saveOptions({...options,hold:{until:'chapter',chapter:plan.chapter,
        reasonKey:'Calendar.ManualDetected'}});
      return report('held',t('Calendar.ManualStatus'));
    }

    const range = plan.temperatureRange;
    const wrongTemperature = plan.temperatureRequired && (!Number.isFinite(current?.temperature)
      || (Array.isArray(range) ? current.temperature < range[0] || current.temperature > range[1]
        : current.temperature !== plan.weather.temperature));
    const changeWeather = !current || (plan.weatherRequired && current.id !== plan.weather.id) || wrongTemperature;
    if (changeWeather && deps.clearsForecast()) return report('forecast-conflict',
      t('Calendar.ForecastHelp'));

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
        reasonKey:'Calendar.ManualDuringSync'}});
      return report('held',t('Calendar.KeepConcurrent'));
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
        if (api.getActiveCalendar()?.weather?.activeZone !== plan.zoneId) throw new Error(t('Calendar.ZoneRejected'));
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
        if (after?.id !== id || after?.temperature !== temperature) throw new Error(t('Calendar.WeatherRejected'));
        applied = fingerprint(after);
      }
    } finally { writing--;activeWrite = undefined; }
    const accepted = changeWeather ? applied : force || chapterChanged || holdExpired || activeZone !== plan.zoneId
      ? fingerprint(api.getCurrentWeather(plan.zoneId)) : sameCalendar && previous.zoneId === plan.zoneId ? applied : null;
    const next = {calendarId,chapter:plan.chapter,zoneId:plan.zoneId,key:plan.key,weather:accepted};
    if (!equal(previous,next) && deps.isPrimary()) await deps.saveState(next);
    return report('synced',t('Calendar.Status',{chapter:plan.chapter,weather:plan.window}));
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
        catch (error) { report('error',t('Calendar.Failed'),error); }
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
  if (!config.enabled) return {valid:false,reason:t('Calendar.ModuleDisabled')};
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
  game.settings.register(ID,'calendar',{name:t('Calendar.Settings'),scope:'world',config:false,type:Object,
    default:{enabled:true,hold:null}});
  game.settings.register(ID,'calendarState',{name:t('Calendar.Records'),scope:'world',config:false,type:Object,default:{}});
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
