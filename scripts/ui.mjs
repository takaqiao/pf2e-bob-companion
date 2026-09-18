import { ID, CHAPTER_NAMES } from './model.mjs';
import { status, refresh, getEnvironment } from './runtime.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const exposureChoices = {unknown:'待 GM 判断',outdoors:'户外：风雨均暴露',indoors:'室内／完全遮蔽','rain-shelter':'户外：仅避雨','wind-shelter':'户外：仅避风'};
const roleChoices = {auto:'自动判断',pc:'玩家角色',enemy:'敌人',ally:'友军／同伴',ignore:'不应用本模组规则'};
const select = (name,label,choices,value) => `<label class="bob-field"><span>${escape(label)}</span><select name="${name}">${Object.entries(choices).map(([key,text])=>`<option value="${escape(key)}" ${String(value)===key?'selected':''}>${escape(text)}</option>`).join('')}</select></label>`;
const checkbox = (name,label,value) => `<label class="bob-field"><span>${escape(label)}</span><input type="checkbox" name="${name}" ${value?'checked':''}></label>`;
const clock = minute => Number.isFinite(minute) ? `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(Math.floor(minute%60)).padStart(2,'0')}` : '未知';
const formData = dialog => new FormData(dialog.element.querySelector('form'));
const flags = doc => doc?.flags?.[ID] ?? {};
const gmOnly = () => game.user.isGM || (ui.notifications.warn('BoB 判定与覆盖仅供 GM 使用。'),false);

function summary(actor) {
  const s=status(actor),e=s.environment ?? getEnvironment();
  const environmentText=e.valid ? `第${e.chapter}章 · ${CHAPTER_NAMES[e.chapter-1]} · ${clock(e.minute)} · ${e.night?'夜间':'白昼'}` : '章节／时间未知，规则暂停';
  const range=e.valid ? e.chapter===9?'永夜；14:00最后一次瞬间升落由GM叙述':`日出 ${clock(e.dawn)} ／ 日落 ${clock(e.dusk)}` : '';
  return `<section class="bob-summary"><strong>${escape(environmentText)}</strong><p>${escape(range)}</p><p>${escape(s.reason ?? '')}</p>
    ${actor?`<p>角色：${escape(actor.name)} · ${escape(roleChoices[s.role] ?? s.role ?? '未判定')} · ${escape(exposureChoices[s.exposure] ?? s.exposure ?? '未判定')}</p>`:''}
    ${s.officialEffects?.length?'<p>检测到原生天空效果：已确认天气条件时临时接管，原始物品保留。</p>':''}
    ${(s.rules?.length)?`<ul>${s.rules.map(r=>`<li>${escape(r.label ?? r.title)}${typeof r.value==='number'?`：${r.value>0?'+':''}${r.value} 环境`:''}${r.predicate?.includes('item:trait:visual')?'（仅带 visual 的检定；普通视觉察觉需手动标记）':''}</li>`).join('')}</ul>`:'<p>该角色目前没有新增修正。</p>'}</section>`;
}

/** Open this through module settings, the Actors button, or the public module API. */
export async function openPanel(actor) {
  if (!gmOnly()) return;
  actor ??= canvas.tokens?.controlled?.[0]?.actor ?? game.user.character;
  const cfg=game.settings.get(ID,'config'),e=getEnvironment();
  const chapters={0:'跟随官方章节管理器',...Object.fromEntries(CHAPTER_NAMES.map((name,i)=>[i+1,`${i+1} · ${name}`]))};
  const actors=Object.fromEntries(game.actors.filter(a=>['character','npc'].includes(a.type)).map(a=>[a.id,a.name]));
  const result=await foundry.applications.api.DialogV2.wait({
    window:{title:'BoB｜昼夜与章节风暴'},classes:['bob-companion'],position:{width:620},
    content:`${summary(actor)}<fieldset><legend>全岛规则</legend>
      ${checkbox('enabled','启用昼夜与风暴规则',cfg.enabled)}
      ${select('chapter','当前章节',chapters,cfg.chapter)}
      ${select('phase','昼夜覆盖',{auto:'按章节叙事时间',day:'强制白昼',night:'强制夜间'},cfg.phase)}
      ${checkbox('weather','接管章节天气修正',cfg.weather)}
      ${checkbox('stormEnded','剧情风暴已停止（保留夜幕）',cfg.stormEnded)}
      ${select('rain','降雨覆盖（不改变视觉）',{auto:'按章节与停雨时段',rain:'仍在下雨',dry:'已停雨'},cfg.rain)}
      <div class="bob-field"><label>第六章每日停雨（GM时段）</label><span><input name="rainStart" type="time" value="${clock(cfg.rainBreak?.[0] ?? 780)}"> 至 <input name="rainEnd" type="time" value="${clock(cfg.rainBreak?.[1] ?? 870)}"></span></div>
    </fieldset><fieldset><legend>场景与角色</legend><p>当前查看场景：${escape(canvas.scene?.name ?? '未载入')}。自动判断 linked 角色使用玩家激活场景。</p>
    ${select('actorId','编辑未放置的角色',{'':'选择角色',...actors},actor?.isToken?'':actor?.id ?? '')}</fieldset>
    <details><summary>本章仍需 GM 判断</summary><ul>${(e.notes ?? []).map(n=>`<li>${escape(n)}</li>`).join('')}</ul></details>
    <p class="hint">面板是打开时的判定快照。不会修改时间、日历、天气特效或声音。停用只移除本模组的临时规则；先前手动添加的官方天空效果会恢复原有行为。</p>`,
    buttons:[
      {action:'save',label:'保存规则',icon:'fa-solid fa-check',default:true,callback:(_ev,_button,dialog)=>({action:'save',data:formData(dialog)})},
      {action:'scene',label:'场景设置',callback:()=>({action:'scene'})},
      {action:'region',label:'区域设置',callback:()=>({action:'region'})},
      {action:'token',label:'所选棋子设置',callback:()=>({action:'token'})},
      {action:'actor',label:'角色设置',callback:(_ev,_button,dialog)=>({action:'actor',id:formData(dialog).get('actorId')})},
      {action:'refresh',label:'刷新',callback:()=>({action:'refresh'})}
    ]
  });
  if (!result) return;
  if (result.action==='scene') return configureScene();
  if (result.action==='region') return configureRegion();
  if (result.action==='token') {
    const token=canvas.tokens?.controlled?.[0]?.document;
    if (!token) return ui.notifications.warn('请先选择一个棋子。');
    return configureSubject(token);
  }
  if (result.action==='actor') {
    const target=game.actors.get(result.id);
    if (!target) return ui.notifications.warn('请选择要设置的角色。');
    return configureSubject(target);
  }
  if (result.action==='refresh') { refresh(); return openPanel(actor); }
  const fd=result.data;
  const minutes=key=>{const [h,m]=String(fd.get(key)).split(':').map(Number);return h*60+m;};
  const start=minutes('rainStart'),end=minutes('rainEnd');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end-start<60 || end-start>120) {
    ui.notifications.warn('第六章停雨时段须在同一天，持续1～2小时。未保存。'); return openPanel(actor);
  }
  await game.settings.set(ID,'config',{...cfg,enabled:fd.has('enabled'),chapter:Number(fd.get('chapter')),phase:fd.get('phase'),weather:fd.has('weather'),stormEnded:fd.has('stormEnded'),rain:fd.get('rain'),rainBreak:[start,end]});
  return openPanel(actor);
}

async function configureScene() {
  const scene=canvas.scene;
  if (!scene) return ui.notifications.warn('请先载入一个场景。');
  const current=flags(scene);
  const data=await foundry.applications.api.DialogV2.wait({window:{title:`BoB｜${scene.name}`},position:{width:510},classes:['bob-companion'],content:
    select('scope','场景范围',{auto:'自动（仅官方主岛）',include:'此场景属于受诅咒岛屿',exclude:'不应用BoB规则'},current.scope ?? 'auto')+
    select('exposure','场景默认环境',exposureChoices,current.exposure ?? 'unknown')+
    '<p>主岛为混合室内外场景，建议保留“待GM判断”，再设置各棋子。区域可用本模组API标记，移动时自动重新判断。</p>',
    buttons:[{action:'save',label:'保存',default:true,callback:(_e,_b,d)=>Object.fromEntries(formData(d))}]
  });
  if (data) await scene.update({[`flags.${ID}`]:{...current,...data}});
  return openPanel();
}

async function configureRegion() {
  if (!canvas.scene?.regions?.size) return ui.notifications.warn('当前场景没有区域。可先用Foundry区域工具画出室内／遮蔽范围。');
  const choices=Object.fromEntries(canvas.scene.regions.map(r=>[r.id,`${r.name}（${exposureChoices[flags(r).exposure] ?? '未标记'}）`]));
  const initial=canvas.regions?.controlled?.[0]?.document?.id ?? Object.keys(choices)[0];
  const data=await foundry.applications.api.DialogV2.wait({window:{title:'BoB｜区域环境'},position:{width:510},classes:['bob-companion'],content:
    select('regionId','选择区域',choices,initial)+
    select('exposure','环境标记',{'auto':'移除标记，沿用角色／场景',...exposureChoices},flags(canvas.scene.regions.get(initial)).exposure ?? 'auto')+
    '<p>棋子跨入／移出标记区域后自动重新计算。重叠区域条件冲突时暂停天气修正；棋子明确覆盖优先。检查区域高度与楼层范围，避免将楼上露台误当室内。</p>',
    render:(_event,dialog)=>{dialog.element.querySelector('[name=regionId]').addEventListener('change',event=>{
      dialog.element.querySelector('[name=exposure]').value=flags(canvas.scene.regions.get(event.target.value)).exposure ?? 'auto';
    });},
    buttons:[{action:'save',label:'保存区域标记',default:true,callback:(_e,_b,d)=>Object.fromEntries(formData(d))}]
  });
  if (data) await canvas.scene.regions.get(data.regionId)?.setFlag(ID,'exposure',data.exposure);
  return openPanel();
}

async function configureSubject(subject) {
  const current=flags(subject),isActor=subject.documentName==='Actor';
  const scenes=Object.fromEntries(game.scenes.map(s=>[s.id,s.name]));
  const data=await foundry.applications.api.DialogV2.wait({window:{title:`BoB｜${subject.name}`},position:{width:540},classes:['bob-companion'],content:
    select('role','身份覆盖',roleChoices,current.role ?? 'auto')+
    select('exposure','实际暴露环境',{'auto':'沿用场景／区域／角色',...exposureChoices},current.exposure ?? 'auto')+
    select('perception','察觉方式',{auto:'按检定 visual 特征',visual:'本角色当前以视觉察觉',nonvisual:'本角色当前以非视觉察觉'},current.perception ?? 'auto')+
    (isActor?select('sceneId','未放置角色所在场景',{'':'未指定（不自动应用）',...scenes},current.sceneId ?? ''):'')+
    '<p>棋子覆盖优先。召唤物、友军、敌对关系不明确时请直接指定。视觉覆盖会影响此后的察觉，请在改用听觉等方式时改回；第九章按正文影响所有察觉。</p>',
    buttons:[{action:'save',label:'保存',default:true,callback:(_e,_b,d)=>Object.fromEntries(formData(d))}]
  });
  if (data) await subject.update({[`flags.${ID}`]:{...current,...data}});
  return openPanel(isActor?subject:subject.actor);
}

export function registerUI() {
  const Base=foundry.applications.api.ApplicationV2 ?? foundry.applications.api.Application;
  class SettingsMenu extends Base { render() { void openPanel(); return this; } }
  game.settings.registerMenu(ID,'panel',{name:'BoB规则与判定',label:'打开昼夜与风暴面板',hint:'当前判定、章节／昼夜覆盖、场景与角色设置。',icon:'fa-solid fa-moon',type:SettingsMenu,restricted:true});
  Hooks.on('renderActorDirectory',(_app,element)=>{
    if (!game.user.isGM || element.querySelector('[data-bob-panel]')) return;
    const button=document.createElement('button');button.type='button';button.dataset.bobPanel='true';button.innerHTML='<i class="fa-solid fa-moon"></i> BoB 昼夜与风暴';
    button.addEventListener('click',()=>openPanel());
    (element.querySelector('.directory-header') ?? element).append(button);
  });
  Hooks.once('ready',()=>{game.modules.get(ID).api={...game.modules.get(ID).api,open:openPanel};});
}
