import { ID, OFFICIAL, CHAPTER_NAMES } from './model.mjs';
import { status, getEnvironment } from './runtime.mjs';
import { RuleDraft, describeRule } from './ui-state.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const exposureChoices = {unknown:'待 GM 判断',outdoors:'户外：风雨均暴露',indoors:'室内／完全遮蔽','rain-shelter':'户外：仅避雨','wind-shelter':'户外：仅避风'};
const roleChoices = {auto:'自动判断',pc:'玩家角色',enemy:'敌人',ally:'友军／同伴',ignore:'不应用本模组规则'};
const select = (name,label,choices,value) => `<label class="bob-field"><span>${escape(label)}</span><select name="${name}">${Object.entries(choices).map(([key,text])=>`<option value="${escape(key)}" ${String(value)===key?'selected':''}>${escape(text)}</option>`).join('')}</select></label>`;
const checkbox = (name,label,value) => `<label class="bob-field"><span>${escape(label)}</span><input type="checkbox" name="${name}" ${value?'checked':''}></label>`;
const clock = minute => Number.isFinite(minute) ? `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(Math.floor(minute%60)).padStart(2,'0')}` : '未知';
const flags = doc => doc?.flags?.[ID] ?? {};
const selected = () => Array.from(globalThis.canvas?.tokens?.controlled ?? [],token=>token.document);
const gmOnly = () => game.user?.isGM || (ui.notifications.warn('BoB 判定与覆盖仅供 GM 使用。'),false);
const api = () => game.modules.get(ID)?.api ?? {};
const button = (action,label,extra='') => `<button type="button" data-bob-action="${action}" ${extra}>${label}</button>`;
let panel;

/** This operation never dereferences a token's actor (including lazy synthetic actors). */
export async function applyExposure(tokens,exposure) {
  if(!globalThis.game?.user?.isGM) throw new Error('仅 GM 可以设置环境。');
  if(!['auto','indoors','outdoors'].includes(exposure)) throw new Error('环境设置无效。');
  for(const token of tokens) await token.setFlag(ID,'exposure',exposure);
}

function calendarStatus() {
  try { return api().getCalendarStatus?.() ?? {available:false,label:'未连接 Calendaria',detail:'昼夜与风暴规则仍按 PF2e 世界钟运行。'}; }
  catch(error) { return {available:false,label:'日历状态暂不可读',error:error.message}; }
}
function summary() {
  const e=getEnvironment(),cfg=game.settings.get(ID,'config'),cal=calendarStatus();
  const weather=e.stormEnded?'剧情风暴已停止':!e.valid?'未知':e.fog?'浓雾':e.raining?'风雨':e.chapter>=6?'停雨': '无雨';
  const overrides=[cfg.chapter>0?'章节':null,cfg.phase!=='auto'?'昼夜':null,cfg.rain!=='auto'?'降雨':null].filter(Boolean);
  return `<div class="bob-now"><div><strong>${e.valid?`第${e.chapter}章 · ${escape(CHAPTER_NAMES[e.chapter-1])}`:'章节／时间待确认'}</strong><span>${escape(e.time ?? clock(e.minute))}　${e.valid?(e.night?'夜间':'白昼'):'未知'}</span></div>
    <p>${escape(weather)}${e.valid?`　${e.chapter===9?'永夜；14:00 最后一次升落由 GM 叙述':`日出 ${clock(e.dawn)} ／ 日落 ${clock(e.dusk)}`}`:''}</p></div>
    <div class="bob-sync"><strong>${cfg.enabled?'规则已启用':'规则已暂停'}</strong><span>${escape(cal.label ?? cal.state ?? '日历状态未知')}</span></div>
    <p class="hint">${escape(cal.detail ?? '')}${cal.error?` ${escape(cal.error)}`:''}${cal.overrideUntil?` 手动天气保留至：${escape(cal.overrideUntil)}`:''}</p>
    ${overrides.length?`<p class="bob-warning">手动覆盖：${overrides.join('、')}。可在高级页恢复自动。</p>`:''}
    ${!cfg.weather?'<p class="hint">天气修正接管已关闭；已有原生天空效果继续生效。</p>':''}`;
}
function subjectSummary(token,actor) {
  if(!actor) return `<article class="bob-subject"><h3>${escape(token?.name ?? '未指定角色')}</h3><p>棋子未关联可用角色。</p></article>`;
  const s=status(actor),rows=s.rules.map(describeRule);
  const reason=s.reason || (!s.enabled?'当前不适用。':s.exposure==='indoors'?'室内完全遮蔽，不应用户外风雨修正。':rows.length?'':'当前时段与条件下没有新增修正。');
  const origin=token&&flags(token).exposure&&flags(token).exposure!=='auto'?'棋子手动覆盖':'按区域／角色／场景判断';
  return `<article class="bob-subject"><h3>${escape(token?.name ?? actor.name)} <span>${escape(roleChoices[s.role] ?? '身份待确认')}</span></h3>
    <p class="hint">${escape(exposureChoices[s.exposure] ?? '环境待确认')} · ${escape(origin)}</p>${reason?`<p class="${!s.enabled||s.exposure==='unknown'?'bob-warning':'hint'}">${escape(reason)}</p>`:''}
    ${rows.length?`<table class="bob-rules"><caption class="sr-only">${escape(actor.name)} 的规则修正</caption><thead><tr><th>影响</th><th>环境修正</th><th>来源与条件</th></tr></thead><tbody>${rows.map(r=>`<tr><th scope="row">${escape(r.target)}</th><td class="bob-modifier">${escape(r.value)}</td><td>${escape(r.source)}${r.conditional?`<small>条件生效：${escape(r.condition)}</small>`:''}</td></tr>`).join('')}</tbody></table>`:''}
    ${s.officialEffects?.length?`<p class="hint">原生天空效果：${s.managedWeather?'本模组接管适用天气修正，原始物品保留。':'继续按原有规则生效。'}</p>`:''}</article>`;
}
function selectionSummary(actor) {
  const tokens=selected();
  if(tokens.length) return tokens.map(token=>subjectSummary(token,token.actor)).join('');
  if(actor) return `<p class="hint">未选中棋子，正在查看指定角色。</p>${subjectSummary(null,actor)}`;
  return '<div class="bob-empty"><strong>先选择地图上的棋子</strong><p>这里会显示其察觉、远程打击、先攻与豁免修正。多选可一起设置室内外。</p></div>';
}

function content(cfg) {
  const chapters={0:'跟随官方章节管理器',...Object.fromEntries(CHAPTER_NAMES.map((name,i)=>[i+1,`${i+1} · ${name}`]))};
  return `<nav class="bob-tabs" role="tablist" aria-label="BoB 控制台"><button type="button" role="tab" id="bob-tab-overview" aria-controls="bob-pane-overview" aria-selected="true" data-tab="overview">总览</button><button type="button" role="tab" id="bob-tab-preparation" aria-controls="bob-pane-preparation" aria-selected="false" tabindex="-1" data-tab="preparation">场景准备</button><button type="button" role="tab" id="bob-tab-advanced" aria-controls="bob-pane-advanced" aria-selected="false" tabindex="-1" data-tab="advanced">高级</button></nav>
  <div class="bob-body"><section id="bob-pane-overview" role="tabpanel" aria-labelledby="bob-tab-overview" data-pane="overview">
    <div data-live="summary"></div><div class="bob-toolbar">${button('sync','立即同步日历')}${button('resume','恢复日历自动')}${button('refresh','刷新状态')}</div><div data-calendar-prepare hidden><p class="hint">关闭手动改天气时重建预报；保留现有预报和每日天气生成。</p>${button('prepare','启用自动同步并保留预报')}</div>
    <div class="bob-section-title"><h2>所选棋子</h2><span data-live="count"></span></div>
    <div class="bob-toolbar bob-exposure">${button('indoors','设为室内')}${button('outdoors','设为户外')}${button('auto','恢复环境自动')}</div>
    <div data-live="selection"></div><details><summary>本章仍需 GM 判断</summary><ul data-live="notes"></ul></details>
  </section><section id="bob-pane-preparation" role="tabpanel" aria-labelledby="bob-tab-preparation" data-pane="preparation" hidden>
    <h2>确认地图范围与遮蔽</h2><p data-live="scene"></p><p class="hint">主岛为混合室内外场景。先确认场景范围，再为室内、露台或避雨处设置区域；已有视觉天气遮挡不会直接当作规则遮蔽。</p>
    <div class="bob-toolbar">${button('scene','场景范围与默认环境')}${button('region','设置区域环境')}</div>
    <fieldset><legend>判定顺序</legend><p>棋子明确覆盖 → 区域标记 → 角色设置 → 场景默认环境。</p><p class="hint">重叠区域冲突时保留“待判断”。请检查高度与楼层范围；仅避雨、仅避风可在区域设置中选择。</p></fieldset>
  </section><section id="bob-pane-advanced" role="tabpanel" aria-labelledby="bob-tab-advanced" data-pane="advanced" hidden>
    <form class="bob-config"><fieldset><legend>规则与手动覆盖</legend>${checkbox('enabled','启用昼夜与风暴规则',cfg.enabled)}${select('chapter','章节来源',chapters,cfg.chapter)}${select('phase','昼夜覆盖',{auto:'自动：按章节与世界时间',day:'强制白昼',night:'强制夜间'},cfg.phase)}${checkbox('weather','接管章节天气修正',cfg.weather)}${select('rain','规则降雨覆盖',{auto:'自动：按章节与停雨时段',rain:'仍在下雨',dry:'已停雨'},cfg.rain)}<p class="hint">覆盖会持续到手动改回“自动”。设置不改变世界时间。</p></fieldset>
    <fieldset><legend>第六章停雨时段</legend><div class="bob-field"><span>每天停雨 1～2 小时</span><span class="bob-time-range"><input aria-label="停雨开始" name="rainStart" type="time" value="${clock(cfg.rainBreak?.[0] ?? 780)}">至<input aria-label="停雨结束" name="rainEnd" type="time" value="${clock(cfg.rainBreak?.[1] ?? 870)}"></span></div><p class="hint">默认 13:00–14:30，为 GM 校准值；规则与日历同步共用此时段。</p></fieldset>
    <fieldset data-chapter-nine ${getEnvironment().chapter===9||cfg.stormEnded?'':'hidden'}><legend>终局</legend>${checkbox('stormEnded','剧情风暴已停止（保留夜幕）',cfg.stormEnded)}<p class="hint">解除诅咒后，可关闭全部伴随规则。残留积水与寒冷仍由 GM 裁定。</p></fieldset></form>
    <fieldset><legend>日历自动同步</legend><p class="hint">手动调整日历天气前，可保留天气至下一章。日历缺失时核心规则仍工作。</p><div class="bob-toolbar">${button('hold','保留手动天气至下一章')}${button('resume','恢复日历自动')}</div></fieldset>
    <fieldset><legend>角色与例外</legend><p class="hint">为所选棋子指定身份、非视觉察觉等例外；未放置角色可明确绑定场景。</p><div class="bob-toolbar">${button('token','所选棋子详细设置')}${button('actor','选择角色设置')}</div></fieldset>
  </section></div><footer class="bob-footer"><span data-draft-status role="status">设置已保存</span><div>${button('reload','载入已保存设置')}${button('save','保存规则','disabled')}</div></footer><p class="bob-feedback" data-feedback role="status"></p>`;
}

function panelClass() {
  return class CompanionPanel extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS={id:'bob-companion-panel',classes:['bob-companion','bob-console'],window:{title:'BoB｜昼夜与章节风暴',resizable:true},position:{width:650,height:720},tag:'div'};
    constructor(actor) { super();this.actor=actor;this.draft=new RuleDraft(game.settings.get(ID,'config'));this.liveHooks=[];this.liveTimer=null;this.timeKey='';this.busy=false; }
    async _renderHTML() { return content(this.draft.value); }
    _replaceHTML(result,element) { element.innerHTML=result; }
    async _onRender(context,options) {
      await super._onRender(context,options);
      this.element.addEventListener('click',event=>this.onClick(event));
      this.element.addEventListener('input',event=>this.onInput(event));
      this.element.addEventListener('keydown',event=>this.onKey(event));
      this.element.querySelector('form').addEventListener('submit',event=>{event.preventDefault();void this.act('save');});
      this.attachHooks();this.updateLive();
    }
    attachHooks() {
      if(this.liveHooks.length) return;
      for(const name of ['controlToken','updateActor','updateUser','updateScene','updateRegion','canvasReady',`${ID}.refresh`,`${ID}.calendar`]) {
        this.liveHooks.push([name,Hooks.on(name,()=>this.queueLive())]);
      }
      this.liveHooks.push(['updateToken',Hooks.on('updateToken',token=>{
        if(selected().some(current=>current.id===token.id&&current.parent?.id===token.parent?.id))this.queueLive();
      })]);
      this.liveHooks.push(['updateSetting',Hooks.on('updateSetting',setting=>{
        if([`${ID}.config`,`${ID}.calendar`,`${ID}.calendarState`,`${OFFICIAL}.campaign`,'pf2e.worldClock','calendaria.currentWeather','calendaria.gmOverrideClearsForecast'].includes(setting.key))this.queueLive();
      })]);
      this.liveHooks.push(['updateWorldTime',Hooks.on('updateWorldTime',()=>{
        const e=getEnvironment(),key=`${e.chapter}:${Math.floor(e.minute)}`;
        if(key!==this.timeKey) {this.timeKey=key;this.queueLive();}
      })]);
    }
    queueLive() { if(this.liveTimer || !this.rendered) return;this.liveTimer=setTimeout(()=>{this.liveTimer=null;this.updateLive();},80); }
    updateLive() {
      if(!this.element?.isConnected) return;
      if(!game.user?.isGM) {void this.close({discard:true});return;}
      const tokens=selected(),cal=calendarStatus(),e=getEnvironment();
      this.timeKey=`${e.chapter}:${Math.floor(e.minute)}`;
      const values={summary:summary(),count:`${tokens.length} 个已选`,selection:selectionSummary(this.actor),scene:`当前场景：${escape(canvas.scene?.name ?? '未载入')}`,notes:(e.notes??[]).map(n=>`<li>${escape(n)}</li>`).join('')};
      for(const [name,html] of Object.entries(values)) {const target=this.element.querySelector(`[data-live="${name}"]`);if(target.innerHTML!==html) target.innerHTML=html;}
      for(const target of this.element.querySelectorAll('.bob-exposure button')) target.disabled=this.busy||!tokens.length;
      for(const target of this.element.querySelectorAll('[data-bob-action="sync"],[data-bob-action="resume"],[data-bob-action="hold"]')) target.disabled=this.busy||!cal.available;
      this.element.querySelector('[data-calendar-prepare]').hidden=cal.state!=='forecast-conflict';
      this.element.querySelector('[data-bob-action="prepare"]').disabled=this.busy;
      this.element.querySelector('[data-chapter-nine]').hidden=!(e.chapter===9||Number(this.draft.value.chapter)===9||this.draft.value.stormEnded);
      this.updateDirty();
    }
    updateDirty() {this.element.querySelector('[data-draft-status]').textContent=this.draft.dirty?'有未保存的修改':'设置已保存';this.element.querySelector('[data-bob-action="save"]').disabled=this.busy||!this.draft.dirty;}
    onInput(event) {
      const field=event.target;if(!field.closest('.bob-config')||!field.name)return;
      if(field.name.startsWith('rain')&&['rainStart','rainEnd'].includes(field.name)) {
        const minutes=name=>{const value=this.element.querySelector(`[name="${name}"]`).value;if(!/^\d{2}:\d{2}$/.test(value))return NaN;const [h,m]=value.split(':').map(Number);return h*60+m;};
        this.draft.set('rainBreak',[minutes('rainStart'),minutes('rainEnd')]);
      } else this.draft.set(field.name,field.type==='checkbox'?field.checked:field.name==='chapter'?Number(field.value):field.value);
      this.updateDirty();this.element.querySelector('[data-feedback]').textContent='';
      this.element.querySelector('[data-chapter-nine]').hidden=!(getEnvironment().chapter===9||Number(this.draft.value.chapter)===9||this.draft.value.stormEnded);
    }
    tab(name,focus=false) {
      for(const tab of this.element.querySelectorAll('[role="tab"]')) {const active=tab.dataset.tab===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();}
      for(const pane of this.element.querySelectorAll('[data-pane]'))pane.hidden=pane.dataset.pane!==name;
    }
    onKey(event) { if(event.target.getAttribute('role')!=='tab')return;const names=['overview','preparation','advanced'];let i=names.indexOf(event.target.dataset.tab);if(event.key==='ArrowRight')i=(i+1)%3;else if(event.key==='ArrowLeft')i=(i+2)%3;else if(event.key==='Home')i=0;else if(event.key==='End')i=2;else return;event.preventDefault();this.tab(names[i],true); }
    onClick(event) {const target=event.target.closest('button');if(target?.dataset.tab)this.tab(target.dataset.tab);else if(target?.dataset.bobAction)void this.act(target.dataset.bobAction);}
    async act(action) {
      if(!gmOnly()||this.busy)return;
      this.busy=true;this.updateDirty();
      try {
        if(['indoors','outdoors','auto'].includes(action)) {const tokens=selected();if(!tokens.length)throw new Error('请先选择棋子。');await applyExposure(tokens,action);this.message(`已更新 ${tokens.length} 个所选棋子的环境。`);}
        else if(action==='save') {await this.draft.save(()=>game.settings.get(ID,'config'),value=>game.settings.set(ID,'config',value));this.syncFields();this.message('规则已保存。');}
        else if(action==='reload') {if(this.draft.dirty&&!await foundry.applications.api.DialogV2.confirm({window:{title:'载入已保存设置'},content:'<p>这会放弃面板中未保存的规则修改。</p>'}))return;this.draft=new RuleDraft(game.settings.get(ID,'config'));this.syncFields();this.message('已载入最新设置。');}
        else if(action==='scene')await configureScene();
        else if(action==='region')await configureRegion();
        else if(action==='token') {const token=selected()[0];if(!token)throw new Error('请先选择一个棋子。');await configureSubject(token);}
        else if(action==='actor')await chooseActor();
        else if(action==='sync') {const result=await api().syncCalendar?.({force:true});this.message(result?.error??'已请求同步日历；请查看同步状态。');}
        else if(action==='resume') {await api().resumeCalendar?.();this.message('已请求恢复日历自动同步。');}
        else if(action==='hold') {await api().holdCalendar?.({until:'chapter'});this.message('已请求保留手动天气至下一章。');}
        else if(action==='prepare') {const result=await api().prepareCalendar?.();this.message(result?.error??'已请求启用自动同步并保留预报；请查看同步状态。');}
        else if(action==='refresh')this.message('已刷新显示；未修改时间或规则。');
      } catch(error) {this.message(`${error.message} 未保存的修改仍保留。`,true);}
      finally {this.busy=false;this.updateLive();}
    }
    syncFields() {for(const field of this.element.querySelectorAll('.bob-config [name]')) {const value=field.name==='rainStart'?clock(this.draft.value.rainBreak[0]):field.name==='rainEnd'?clock(this.draft.value.rainBreak[1]):this.draft.value[field.name];if(field.type==='checkbox')field.checked=Boolean(value);else field.value=value;}}
    message(text,error=false) {const target=this.element.querySelector('[data-feedback]');target.textContent=text;target.classList.toggle('bob-warning',error);}
    async close(options={}) {
      if(this.draft.dirty&&!options.discard&&!await foundry.applications.api.DialogV2.confirm({window:{title:'关闭 BoB 控制台'},content:'<p>有未保存的规则修改。关闭并放弃这些修改？</p>'}))return this;
      clearTimeout(this.liveTimer);for(const [name,id] of this.liveHooks)Hooks.off(name,id);this.liveHooks=[];
      const result=await super.close(options);if(panel===this)panel=null;return result;
    }
  };
}

/** Existing settings, directory button and public API share a single draft-preserving window. */
export async function openPanel(actor) {
  if(!gmOnly())return;
  if(panel?.rendered) {if(actor)panel.actor=actor;panel.updateLive();panel.bringToFront();return panel;}
  const Panel=panelClass();panel=new Panel(actor);await panel.render({force:true});return panel;
}

/** Foundry leaves submit buttons disabled when its callback rejects. Restore them for retry. */
export function createEditorDialog(Base,sourceScene) {
  return class extends Base {
    async _onRender(context,options) {await super._onRender(context,options);const region=this.element.querySelector('[name="regionId"]');if(region)region.addEventListener('change',()=>{this.element.querySelector('[name="exposure"]').value=flags(sourceScene?.regions.get(region.value)).exposure ?? 'auto';});}
    async _onSubmit(...args) {
      const prior=Array.from(this.element.querySelectorAll('button[data-action]'),button=>[button,button.disabled]);
      try {return await super._onSubmit(...args);}
      catch {for(const [button,disabled] of prior)button.disabled=disabled;return this;}
    }
  };
}
async function editDialog(title,body,save,sourceScene) {
  const Dialog=createEditorDialog(foundry.applications.api.DialogV2,sourceScene);
  return Dialog.wait({window:{title},position:{width:530},classes:['bob-companion'],content:body+'<p class="bob-warning" data-save-error role="alert"></p>',buttons:[{action:'save',label:'保存',default:true,callback:async(_event,_button,dialog)=>{
    if(!gmOnly())throw new Error('仅 GM 可以保存。');
    try {const data=Object.fromEntries(new FormData(dialog.element.querySelector('form')));await save(data);return true;}
    catch(error) {dialog.element.querySelector('[data-save-error]').textContent=`保存失败：${error.message}。输入已保留。`;throw error;}
  }}]});
}
async function configureScene() {
  const scene=canvas.scene;if(!scene)throw new Error('请先载入一个场景。');
  const current=flags(scene);
  return editDialog(`BoB｜${scene.name}`,select('scope','场景范围',{auto:'自动（仅官方主岛）',include:'此场景属于受诅咒岛屿',exclude:'不应用 BoB 规则'},current.scope??'auto')+select('exposure','场景默认环境',exposureChoices,current.exposure??'unknown')+'<p class="hint">混合室内外地图建议保留“待 GM 判断”，再为区域设置遮蔽。</p>',data=>scene.update({[`flags.${ID}.scope`]:data.scope,[`flags.${ID}.exposure`]:data.exposure}));
}
async function configureRegion() {
  const scene=canvas.scene;if(!scene?.regions?.size)throw new Error('当前场景没有区域。请先用 Foundry 区域工具画出遮蔽范围。');
  const choices=Object.fromEntries(scene.regions.map(r=>[r.id,`${r.name}（${exposureChoices[flags(r).exposure]??'未标记'}）`]));
  const initial=canvas.regions?.controlled?.[0]?.document?.id??Object.keys(choices)[0];
  return editDialog(`BoB｜${scene.name} · 区域环境`,select('regionId','选择区域',choices,initial)+select('exposure','环境标记',{auto:'移除标记，沿用角色／场景',...exposureChoices},flags(scene.regions.get(initial)).exposure??'auto')+'<p class="hint">棋子跨入或移出区域后自动判断。重叠区域冲突时暂停天气修正；请检查高度与楼层。</p>',data=>scene.regions.get(data.regionId).setFlag(ID,'exposure',data.exposure),scene);
}
async function chooseActor() {
  const actors=Object.fromEntries(game.actors.filter(a=>['character','npc'].includes(a.type)).map(a=>[a.id,a.name]));
  const id=await foundry.applications.api.DialogV2.wait({window:{title:'BoB｜选择角色'},position:{width:450},classes:['bob-companion'],content:select('actorId','要编辑的角色',{'':'选择角色',...actors},''),buttons:[{action:'choose',label:'打开设置',callback:(_e,_b,d)=>new FormData(d.element.querySelector('form')).get('actorId')}]});
  if(id)await configureSubject(game.actors.get(id));
}
async function configureSubject(subject) {
  if(!subject)throw new Error('角色已不存在。');
  const current=flags(subject),isActor=subject.documentName==='Actor';
  const scenes=isActor?Object.fromEntries(game.scenes.map(s=>[s.id,s.name])):{};
  return editDialog(`BoB｜${subject.name}`,select('role','身份覆盖',roleChoices,current.role??'auto')+select('exposure','实际暴露环境',{auto:'沿用场景／区域／角色',...exposureChoices},current.exposure??'auto')+select('perception','察觉方式',{auto:'按检定视觉特征',visual:'当前以视觉察觉',nonvisual:'当前以非视觉察觉'},current.perception??'auto')+(isActor?select('sceneId','未放置角色所在场景',{'':'未指定（不自动应用）',...scenes},current.sceneId??''):'')+'<p class="hint">视觉覆盖会持续影响察觉；改用听觉等方式后请恢复自动。第九章天气影响所有察觉。</p>',data=>subject.update(Object.fromEntries(Object.entries(data).map(([key,value])=>[`flags.${ID}.${key}`,value]))));
}

export function registerUI() {
  class SettingsMenu extends foundry.applications.api.ApplicationV2 {render(){void openPanel();return this;}}
  game.settings.registerMenu(ID,'panel',{name:'BoB 规则与判定',label:'打开昼夜与风暴面板',hint:'当前环境、所选棋子修正与场景准备。',icon:'fa-solid fa-moon',type:SettingsMenu,restricted:true});
  Hooks.on('renderActorDirectory',(_app,element)=>{
    if(!game.user.isGM||element.querySelector('[data-bob-panel]'))return;
    const entry=document.createElement('button');entry.type='button';entry.dataset.bobPanel='true';entry.innerHTML='<i class="fa-solid fa-moon" aria-hidden="true"></i> BoB 昼夜与风暴';entry.addEventListener('click',()=>openPanel());(element.querySelector('.directory-header')??element).append(entry);
  });
  Hooks.once('ready',()=>{game.modules.get(ID).api={...game.modules.get(ID).api,open:openPanel};});
}
