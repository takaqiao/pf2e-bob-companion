import {AREAS} from './model.mjs';

// Numeric temperatures and winds are the existing GM calibration, not new rules.
const WEATHER = ['clear','overcast','overcast','fog','bob-cold-drizzle','bob-cold-rain',
  'bob-cold-thunderstorm','bob-severe-thunderstorm','bob-severe-thunderstorm'];
const TEMPERATURE = [11,8,7,6,-3,-3,-4,-5,-15];
const WIND = [1,1,2,0,2,3,3,4,4];

/** A semantic plan; ordinary time ticks never change its key. */
export function calendarPlan({environment:e,config={}}={}) {
  const chapter=e?.chapter;
  const zoneId=AREAS[chapter-1] ? `bob-${AREAS[chapter-1]}` : null;
  const unavailable=reason=>({valid:false,chapter,zoneId,reason});
  if (!e?.valid || !zoneId || !Number.isFinite(e.minute)) return unavailable('章节或世界时间未知，日历同步暂停。');
  if (e.stormEnded || config.stormEnded) return unavailable('剧情风暴已停止；自动日历天气暂停，请按剧情手动设置天气。');
  if (config.rain==='dry' && [5,7,8,9].includes(chapter)) return unavailable('已强制停雨；请在日历中选择符合当前剧情的天气，恢复自动降雨后继续同步。');

  let id=WEATHER[chapter-1],temperature=TEMPERATURE[chapter-1],temperatureRange;
  let exception=false,window='常态';
  if (chapter===2 && e.minute>=660 && e.minute<780) {
    id='clear';exception=true;window='短暂放晴';
  }
  if (chapter===4) {
    id=e.fog ? 'fog' : 'clear';
    exception=!e.fog;window=e.fog ? '浓雾' : '散雾';
    temperature=e.night ? -2 : 6;
    temperatureRange=e.night ? [-4,-1] : [3,8];
  }
  if (chapter===6 && !e.raining) {
    id='bob-cold-overcast';exception=true;window='雨歇';
  }
  if (chapter===8) {
    const severe=e.cold==='严重寒冷';
    temperature=severe ? -15 : -5;
    temperatureRange=severe ? [-18,-12] : [-7,-2];
    window=severe ? '夜间严寒' : '白昼寒冷';
    if (e.minute<30) {id='bob-cold-snow';exception=true;window='短暂飞雪';}
  }
  if (chapter===9) {temperatureRange=[-18,-12];window='永夜风暴';}
  const speed=WIND[chapter-1];
  const weather={id,temperature,wind:{speed,kph:[0,12,30,50,75][speed],direction:speed ? 112.5 : null,forced:false}};
  return {valid:true,chapter,zoneId,weather,window,exception,weatherRequired:chapter>=2,
    temperatureRequired:Boolean(temperatureRange),temperatureRange,
    key:JSON.stringify([chapter,id,temperatureRange ?? null])};
}
