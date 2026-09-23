import {t,localizeHTML} from './i18n.mjs';
export const ID = 'pf2e-bob-companion';
export const OFFICIAL = 'pf2e-bastion-of-blasphemies';
export const MAIN_SCENE = 'z8wkbcziQufR7jWG';
export const AREAS = ['shore','grounds','cellars','reception','dungeon','private','temple','vault','towers'];
export const CHAPTER_NAMES = AREAS.map(area=>`Chapter.${area}`);
const DAYLIGHT = [[450,1170],[480,1140],[510,1110],[540,1080],[600,1080],[660,1020],[720,960],[780,900],[840,840]];
const SKY_IDS = ['KAI0Cx2ys0P56hZw','4azrweHGcJ1XoBqo','9oiPR5aNEpQTzgfD','XVFJTwaE9P3H5IRk','DGrF0tPpGZcNNQUN','lff614VwbcqbXxtO'];
const PERCEPTION = [0,0,0,-2,-1,-2,-3,-3,-4];
const RANGED = [0,0,0,0,0,-1,-2,-3,-4];
const SWIM = [10,10,15,10,15,20,20,30,30];

/** Narrative state only. A game day always remains 86400 seconds. */
export function environmentAt({chapter,seconds,phase='auto',rain='auto',rainBreak=[780,870]} = {}) {
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 9 || !Number.isFinite(seconds)) {
    return {valid:false,chapter,notes:[t('Environment.InvalidClock')]};
  }
  const minute = ((seconds % 86400) + 86400) % 86400 / 60;
  const [dawn,dusk] = DAYLIGHT[chapter-1];
  const night = phase === 'night' || (phase !== 'day' && (chapter === 9 || minute < dawn || minute >= dusk));
  const fog = chapter === 4 && minute >= 120 && minute < 1320;
  const [start,end] = rainBreak;
  const validBreak = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 1440 && start < end;
  const breakNow = chapter === 6 && validBreak && minute >= start && minute < end;
  const raining = chapter >= 5 && (rain === 'rain' || (rain !== 'dry' && !breakNow));
  const perception = (chapter === 4 && !fog) || (chapter >= 5 && chapter <= 8 && !raining) ? 0 : PERCEPTION[chapter-1];
  const coldLevel = chapter === 9 || (chapter === 8 && (minute >= 1260 || minute < 360)) ? 'severe' : chapter >= 5 || (chapter === 4 && night) ? 'mild' : 'cool';
  const cold = t(`Weather.Cold.${coldLevel}`);
  const notes = [t('Environment.Swim',{dc:SWIM[chapter-1]})];
  if (chapter === 4 && fog) notes.push(t('Environment.FogNote'));
  if (chapter >= 4) notes.push(t('Environment.ColdNote',{cold}));
  if (chapter >= 6) notes.push(t('Environment.FlameNote'));
  if (chapter === 6) notes.push(t('Environment.RainBreakNote'));
  if (chapter >= 7) notes.push(t('Environment.ShoreNote',{distance:[5,10,15][chapter-7]}));
  if (chapter >= 8) notes.push(t('Environment.FloodNote'));
  if (chapter === 9) notes.push(t('Environment.LightningNote'),t('Environment.FinalSun'),t('Environment.EndingNote'));
  return {valid:true,chapter,minute,dawn,dusk,night,fog,raining,perception,ranged:chapter === 6 && !raining ? 0 : RANGED[chapter-1],cold,coldLevel,swim:SWIM[chapter-1],notes};
}

/** Conservative opposition detection: a red NPC icon alone is insufficient. */
export function classifyRole({type,owned=false,alliance,dispositions=[],traits=[],override='auto'} = {}) {
  if (['pc','enemy','ally','ignore'].includes(override)) return override;
  if (!['character','npc'].includes(type)) return 'ignore';
  if (owned && type === 'npc') return 'ally';
  const unique = [...new Set(dispositions)];
  if (unique.length > 1) return 'unknown';
  const disposition = unique[0];
  if (type === 'character' && owned && alliance === 'party' && (disposition === undefined || disposition === 1)) return 'pc';
  if (alliance === 'party' && (disposition === undefined || disposition === 1)) return 'ally';
  if (!owned && alliance === 'opposition' && disposition === -1) return 'enemy';
  return 'unknown';
}

const flat = (slug,label,selector,value,predicate) => ({key:'FlatModifier',slug,label,selector,value,type:'circumstance',...(predicate ? {predicate} : {})});

/** Reuses the official FlatModifier selectors and visual trait predicate. */
export function nativeRules({environment:e,role,exposure='unknown',perception='auto'} = {}) {
  if (!e?.valid || role === 'ignore') return [];
  const rules=[];
  if (e.night && role === 'enemy') rules.push(
    flat('bob-moon-initiative',t('Rule.MoonInitiative'),'initiative',1),
    flat('bob-moon-holy',t('Rule.MoonHoly'),'saving-throw',1,['item:trait:holy'])
  );
  if (e.night && role === 'pc') rules.push(flat('bob-moon-fear',t('Rule.MoonFear'),'saving-throw',-1,['item:trait:fear']));
  if (!['outdoors','rain-shelter','wind-shelter'].includes(exposure)) return rules;
  const fogExposed = e.chapter === 4;
  const rainExposed = exposure !== 'rain-shelter';
  const windExposed = exposure !== 'wind-shelter';
  const perceptionExposed = e.chapter === 9 ? rainExposed || windExposed : fogExposed || rainExposed;
  if (e.perception && perceptionExposed && (e.chapter === 9 || perception !== 'nonvisual')) {
    rules.push(flat('bob-weather-perception',t('Rule.Weather'),'perception',e.perception,
      e.chapter === 9 || perception === 'visual' ? undefined : ['item:trait:visual']));
  }
  if (e.ranged && windExposed) rules.push(flat('bob-weather-ranged',t('Rule.Wind'),'ranged-strike-attack-roll',e.ranged));
  if (e.fog) rules.push({key:'Note',slug:'bob-fog',selector:'attack-roll',title:localizeHTML('Rule.Fog'),text:`<p>${localizeHTML('Rule.FogText')}</p>`,predicate:[{gte:['target:distance',50]}]});
  return rules;
}

export function knownSkyEffect(item) {
  const sources = [item?.id,item?._id,item?.sourceId,item?._stats?.compendiumSource,item?.flags?.core?.sourceId];
  for (const source of sources) {
    const index=SKY_IDS.indexOf(String(source ?? '').split('.').at(-1));
    if (index >= 0) return index+4;
  }
  const slug = item?.system?.slug ?? item?.slug;
  const match = /^effect-the-skies-above-chapter-([4-9])$/.exec(slug ?? '');
  return match ? Number(match[1]) : null;
}
