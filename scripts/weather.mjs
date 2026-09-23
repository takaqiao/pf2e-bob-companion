import {t} from './i18n.mjs';
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
  if (!e?.valid || !zoneId || !Number.isFinite(e.minute)) return unavailable(t('Weather.InvalidTime'));
  if (e.stormEnded || config.stormEnded) return unavailable(t('Weather.StormEnded'));
  if (config.rain==='dry' && [5,7,8,9].includes(chapter)) return unavailable(t('Weather.ForcedDry'));

  let id=WEATHER[chapter-1],temperature=TEMPERATURE[chapter-1],temperatureRange;
  let exception=false,window=t('Weather.Normal');
  if (chapter===2 && e.minute>=660 && e.minute<780) {
    id='clear';exception=true;window=t('Weather.SunnyBreak');
  }
  if (chapter===4) {
    id=e.fog ? 'fog' : 'clear';
    exception=!e.fog;window=e.fog ? t('Weather.Fog') : t('Weather.FogCleared');
    temperature=e.night ? -2 : 6;
    temperatureRange=e.night ? [-4,-1] : [3,8];
  }
  if (chapter===6 && !e.raining) {
    id='bob-cold-overcast';exception=true;window=t('Weather.RainBreak');
  }
  if (chapter===8) {
    const severe=e.coldLevel==='severe'||(e.coldLevel==null&&e.cold===t('Weather.SevereCold'));
    temperature=severe ? -15 : -5;
    temperatureRange=severe ? [-18,-12] : [-7,-2];
    window=severe ? t('Weather.NightCold') : t('Weather.DayCold');
    if (e.minute<30) {id='bob-cold-snow';exception=true;window=t('Weather.Snow');}
  }
  if (chapter===9) {temperatureRange=[-18,-12];window=t('Weather.PermanentNight');}
  const speed=WIND[chapter-1];
  const weather={id,temperature,wind:{speed,kph:[0,12,30,50,75][speed],direction:speed ? 112.5 : null,forced:false}};
  return {valid:true,chapter,zoneId,weather,window,exception,weatherRequired:chapter>=2,
    temperatureRequired:Boolean(temperatureRange),temperatureRange,
    key:JSON.stringify([chapter,id,temperatureRange ?? null])};
}
