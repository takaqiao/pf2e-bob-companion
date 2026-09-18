export const ID = 'pf2e-bob-companion';
export const OFFICIAL = 'pf2e-bastion-of-blasphemies';
export const MAIN_SCENE = 'z8wkbcziQufR7jWG';
export const AREAS = ['shore','grounds','cellars','reception','dungeon','private','temple','vault','towers'];
export const CHAPTER_NAMES = ['闹鬼湖岸','城堡场地','地窖','迎宾厅','地牢','私人厅堂','堕落神殿','宝库','高塔'];
const DAYLIGHT = [[450,1170],[480,1140],[510,1110],[540,1080],[600,1080],[660,1020],[720,960],[780,900],[840,840]];
const SKY_IDS = ['KAI0Cx2ys0P56hZw','4azrweHGcJ1XoBqo','9oiPR5aNEpQTzgfD','XVFJTwaE9P3H5IRk','DGrF0tPpGZcNNQUN','lff614VwbcqbXxtO'];
const PERCEPTION = [0,0,0,-2,-1,-2,-3,-3,-4];
const RANGED = [0,0,0,0,0,-1,-2,-3,-4];
const SWIM = [10,10,15,10,15,20,20,30,30];

/** Narrative state only. A game day always remains 86400 seconds. */
export function environmentAt({chapter,seconds,phase='auto',rain='auto',rainBreak=[780,870]} = {}) {
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 9 || !Number.isFinite(seconds)) {
    return {valid:false,chapter,notes:['章节或世界时间无法可靠读取；自动修正暂停。']};
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
  const cold = chapter === 9 || (chapter === 8 && (minute >= 1260 || minute < 360)) ? '严重寒冷' : chapter >= 5 || (chapter === 4 && night) ? '轻度寒冷' : '清冷';
  const notes = [`湖中游泳：运动 DC ${SWIM[chapter-1]}；由 GM 按具体行动调用。`];
  if (chapter === 4 && fog) notes.push('户外浓雾：50英尺及更远的生物隐蔽；逐目标及感官判断，不给全体加隐蔽状态。');
  if (chapter >= 4) notes.push(`气温：${cold}；防寒、暴露时长及寒冷伤害由 GM 处理。`);
  if (chapter >= 6) notes.push('户外未受保护的小型明火会被风雨熄灭；由 GM 判定光源保护。');
  if (chapter === 6) notes.push('每日停雨1～2小时；默认13:00–14:30，可更改，原著未指定具体时刻。按正文“户外下雨期间”限定，两项检定减值均在停雨时暂停；视觉风势不由本模组控制。');
  if (chapter >= 7) notes.push(`距岸线${[5,10,15][chapter-7]}英尺内的陆地为困难地形；由 GM 按位置应用。`);
  if (chapter >= 8) notes.push('地牢E2/E3/E6栈道被2英尺水淹没，涉水为困难地形。');
  if (chapter === 9) notes.push('高塔之间的户外：每10分钟作DC17纯骰，成功则一名户外PC受10d6电击（DC30基础反射）。GM计时并决定合格目标；不擅自选择目标。', '本章最后一次14:00日出即日落，没有持续白昼；此后永夜。该瞬间叙事由GM描述，不每天重播。', '放回徽章时另有一次剧情雷击。终局风暴停止时关闭风暴修正；解除诅咒后关闭全部伴随修正。');
  return {valid:true,chapter,minute,dawn,dusk,night,fog,raining,perception,ranged:chapter === 6 && !raining ? 0 : RANGED[chapter-1],cold,swim:SWIM[chapter-1],notes};
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
    flat('bob-moon-initiative','永恒满月：敌人先攻','initiative',1),
    flat('bob-moon-holy','永恒满月：对抗圣洁','saving-throw',1,['item:trait:holy'])
  );
  if (e.night && role === 'pc') rules.push(flat('bob-moon-fear','永恒满月：对抗恐惧','saving-throw',-1,['item:trait:fear']));
  if (!['outdoors','rain-shelter','wind-shelter'].includes(exposure)) return rules;
  const fogExposed = e.chapter === 4;
  const rainExposed = exposure !== 'rain-shelter';
  const windExposed = exposure !== 'wind-shelter';
  const perceptionExposed = e.chapter === 9 ? rainExposed || windExposed : fogExposed || rainExposed;
  if (e.perception && perceptionExposed && (e.chapter === 9 || perception !== 'nonvisual')) {
    rules.push(flat('bob-weather-perception',`章节风暴（第${e.chapter}章）`,'perception',e.perception,
      e.chapter === 9 || perception === 'visual' ? undefined : ['item:trait:visual']));
  }
  if (e.ranged && windExposed) rules.push(flat('bob-weather-ranged',`章节强风（第${e.chapter}章）`,'ranged-strike-attack-roll',e.ranged));
  if (e.fog) rules.push({key:'Note',selector:'attack-roll',title:'浓雾：隐蔽',text:'若目标在户外浓雾中且距离至少50英尺，按所用感官判断隐蔽（通常DC5纯骰）。由GM确认。',predicate:[{gte:['target:distance',50]}]});
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
