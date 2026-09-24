import { t } from './i18n.mjs';
import { ID, OFFICIAL, CHAPTER_NAMES } from './model.mjs';
import { status, getEnvironment } from './runtime.mjs';
import { RuleDraft, describeRule } from './ui-state.mjs';

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const l = (key, values) => escape(t(`UI.${key}`, values));
const exposureChoices = () => ({
  unknown: l('ExposureUnknown'),
  outdoors: l('ExposureOutdoors'),
  indoors: l('ExposureIndoors'),
  'rain-shelter': l('ExposureRainShelter'),
  'wind-shelter': l('ExposureWindShelter')
});
const roleChoices = () => ({
  auto: l('RoleAuto'),
  pc: l('RolePc'),
  enemy: l('RoleEnemy'),
  ally: l('RoleAlly'),
  ignore: l('RoleIgnore')
});
const select = (name, label, choices, value) =>
  `<label class="bob-field"><span>${escape(label)}</span><select name="${name}">${Object.entries(
    choices
  )
    .map(
      ([key, text]) =>
        `<option value="${escape(key)}" ${String(value) === key ? 'selected' : ''}>${escape(text)}</option>`
    )
    .join('')}</select></label>`;
const checkbox = (name, label, value) =>
  `<label class="bob-field"><span>${escape(label)}</span><input type="checkbox" name="${name}" ${value ? 'checked' : ''}></label>`;
const clock = (minute) =>
  Number.isFinite(minute)
    ? `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`
    : t('Common.Unknown');
const flags = (doc) => doc?.flags?.[ID] ?? {};
const selected = () =>
  Array.from(globalThis.canvas?.tokens?.controlled ?? [], (token) => token.document);
const gmOnly = () => game.user?.isGM || (ui.notifications.warn(t('UI.GmOnly')), false);
const api = () => game.modules.get(ID)?.api ?? {};
const button = (action, label, extra = '') =>
  `<button type="button" data-bob-action="${action}" ${extra}>${label}</button>`;
let panel;

/** This operation never dereferences a token's actor (including lazy synthetic actors). */
export async function applyExposure(tokens, exposure) {
  if (!globalThis.game?.user?.isGM) throw new Error(t('UI.GmOnly'));
  if (!['auto', 'indoors', 'outdoors'].includes(exposure)) throw new Error(t('UI.InvalidExposure'));
  for (const token of tokens) await token.setFlag(ID, 'exposure', exposure);
}

function calendarStatus() {
  try {
    return (
      api().getCalendarStatus?.() ?? {
        available: false,
        label: t('UI.CalendarDisconnected'),
        detail: t('UI.CalendarDisconnectedHint')
      }
    );
  } catch (error) {
    return { available: false, label: t('UI.CalendarUnavailable'), error: error.message };
  }
}
function summary() {
  const e = getEnvironment(),
    cfg = game.settings.get(ID, 'config'),
    cal = calendarStatus();
  const weather = e.stormEnded
    ? l('StormEnded')
    : !e.valid
      ? escape(t('Common.Unknown'))
      : e.fog
        ? escape(t('Weather.Fog'))
        : e.raining
          ? l('RainAndWind')
          : e.chapter >= 6
            ? l('RainStopped')
            : l('NoRain');
  const overrides = [
    cfg.chapter > 0 ? l('Chapter') : null,
    cfg.phase !== 'auto' ? l('TimeOfDay') : null,
    cfg.rain !== 'auto' ? l('Rain') : null
  ].filter(Boolean);
  const chapter = e.valid
    ? l('ChapterSummary', { number: e.chapter, name: t(CHAPTER_NAMES[e.chapter - 1]) })
    : l('ChapterUnknown');
  const daylight = e.valid ? (e.night ? l('Night') : l('Day')) : escape(t('Common.Unknown'));
  const sun = e.valid
    ? e.chapter === 9
      ? l('LastSunset')
      : l('SunriseSunset', { dawn: clock(e.dawn), dusk: clock(e.dusk) })
    : '';
  return `
    <div class="bob-now">
      <div class="bob-now-heading">
        <strong>${chapter}</strong>
        <span class="bob-clock">${escape(e.time ?? clock(e.minute))} ${daylight}</span>
      </div>
      <div class="bob-meta">
        <span>${weather}</span>
        ${sun ? `<span>${sun}</span>` : ''}
      </div>
    </div>
    <div class="bob-sync">
      <strong>${cfg.enabled ? l('RulesOn') : l('RulesOff')}</strong>
      <span>${escape(cal.label ?? cal.state ?? t('UI.CalendarUnknown'))}</span>
    </div>
    ${cal.error ? `<p class="bob-warning">${escape(cal.error)}</p>` : ''}
    ${overrides.length ? `<p class="bob-warning">${l('ManualOverrides', { items: overrides.join(', ') })}</p>` : ''}
    ${!cfg.weather ? `<p class="hint">${l('WeatherRulesOff')}</p>` : ''}`;
}
function subjectSummary(token, actor) {
  if (!actor)
    return `<article class="bob-subject"><h3>${escape(token?.name ?? t('UI.UnknownActor'))}</h3><p>${l('NoActor')}</p></article>`;
  const s = status(actor),
    rows = s.rules.map(describeRule);
  const reason =
    s.reason ||
    (!s.enabled
      ? t('UI.NotApplicable')
      : s.exposure === 'indoors'
        ? t('UI.IndoorsNoWeather')
        : rows.length
          ? ''
          : t('UI.NoModifiers'));
  const origin =
    token && flags(token).exposure && flags(token).exposure !== 'auto'
      ? l('TokenOverride')
      : l('InferredExposure');
  const ruleRows = rows
    .map(
      (rule) => `
    <tr>
      <th scope="row">${escape(rule.target)}</th>
      <td class="bob-modifier">${escape(rule.value)}</td>
      <td>
        ${escape(rule.source)}
        ${rule.conditional ? `<small>${l('Condition', { condition: rule.condition })}</small>` : ''}
      </td>
    </tr>`
    )
    .join('');
  return `
    <article class="bob-subject">
      <h3>${escape(token?.name ?? actor.name)} <span>${roleChoices()[s.role] ?? l('RoleUnknown')}</span></h3>
      <div class="bob-meta hint">
        <span>${exposureChoices()[s.exposure] ?? l('ExposureUnknown')}</span>
        <span>${origin}</span>
      </div>
      ${reason ? `<p class="${!s.enabled || s.exposure === 'unknown' ? 'bob-warning' : 'hint'}">${escape(reason)}</p>` : ''}
      ${
        rows.length
          ? `
        <table class="bob-rules">
          <caption class="sr-only">${l('RuleCaption', { actor: actor.name })}</caption>
          <thead><tr>
            <th scope="col">${l('Effect')}</th>
            <th scope="col">${l('Modifier')}</th>
            <th scope="col">${l('Source')}</th>
          </tr></thead>
          <tbody>${ruleRows}</tbody>
        </table>`
          : ''
      }
      ${s.officialEffects?.length ? `<p class="hint">${s.managedWeather ? l('NativeWeatherManaged') : l('NativeWeatherActive')}</p>` : ''}
    </article>`;
}
function selectionSummary(actor) {
  const tokens = selected();
  if (tokens.length) return tokens.map((token) => subjectSummary(token, token.actor)).join('');
  if (actor) return `<p class="hint">${l('ViewingActor')}</p>${subjectSummary(null, actor)}`;
  return `<p class="bob-empty">${l('SelectTokens')}</p>`;
}

function content(cfg) {
  const chapters = {
    0: l('FollowChapter'),
    ...Object.fromEntries(
      CHAPTER_NAMES.map((name, i) => [i + 1, l('ChapterChoice', { number: i + 1, name: t(name) })])
    )
  };
  return `
    <nav class="bob-tabs" role="tablist" aria-label="${l('PanelTitle')}">
      <button type="button" role="tab" id="bob-tab-overview" aria-controls="bob-pane-overview"
        aria-selected="true" data-tab="overview">${l('Overview')}</button>
      <button type="button" role="tab" id="bob-tab-preparation" aria-controls="bob-pane-preparation"
        aria-selected="false" tabindex="-1" data-tab="preparation">${l('SceneSetup')}</button>
      <button type="button" role="tab" id="bob-tab-advanced" aria-controls="bob-pane-advanced"
        aria-selected="false" tabindex="-1" data-tab="advanced">${l('Advanced')}</button>
    </nav>
    <div class="bob-body">
      <section id="bob-pane-overview" role="tabpanel" aria-labelledby="bob-tab-overview" data-pane="overview">
        <div data-live="summary"></div>
        <div class="bob-toolbar">
          ${button('assistants', l('AdventureTools'), 'class="bob-primary"')}
          ${button('refresh', l('Refresh'))}
        </div>
        <details class="bob-calendar-tools">
          <summary>${l('CalendarControls')}</summary>
          <p class="hint" data-live="calendar-detail"></p>
          <div class="bob-toolbar">
            ${button('sync', l('SyncCalendar'))}
            ${button('resume', l('ResumeCalendar'))}
          </div>
          <div data-calendar-prepare hidden>
            <p class="hint">${l('PrepareForecastHint')}</p>
            ${button('prepare', l('PrepareCalendar'))}
          </div>
        </details>
        <div class="bob-section-title">
          <h2>${l('SelectedTokens')}</h2>
          <span data-live="count"></span>
        </div>
        <div class="bob-toolbar bob-exposure">
          ${button('indoors', l('SetIndoors'))}
          ${button('outdoors', l('SetOutdoors'))}
          ${button('auto', l('UseAutomatic'))}
        </div>
        <div data-live="selection"></div>
        <details>
          <summary>${l('GmNotes')}</summary>
          <ul data-live="notes"></ul>
        </details>
      </section>
      <section id="bob-pane-preparation" role="tabpanel" aria-labelledby="bob-tab-preparation"
        data-pane="preparation" hidden>
        <h2>${l('SceneHeading')}</h2>
        <p data-live="scene"></p>
        <p class="hint">${l('SceneSetupHint')}</p>
        <div class="bob-toolbar">
          ${button('scene', l('SceneSettings'))}
          ${button('region', l('RegionSettings'))}
        </div>
        <details>
          <summary>${l('HowExposureWorks')}</summary>
          <p>${l('ExposurePriority')}</p>
          <p class="hint">${l('OverlapHint')}</p>
        </details>
      </section>
      <section id="bob-pane-advanced" role="tabpanel" aria-labelledby="bob-tab-advanced"
        data-pane="advanced" hidden>
        <form class="bob-config">
          <fieldset>
            <legend>${l('RulesAndOverrides')}</legend>
            ${checkbox('enabled', l('EnableRules'), cfg.enabled)}
            ${select('chapter', l('ChapterSource'), chapters, cfg.chapter)}
            ${select('phase', l('TimeOverride'), { auto: l('Automatic'), day: l('ForceDay'), night: l('ForceNight') }, cfg.phase)}
            ${checkbox('weather', l('ManageWeatherRules'), cfg.weather)}
            ${select('rain', l('RainOverride'), { auto: l('Automatic'), rain: l('ForceRain'), dry: l('ForceDry') }, cfg.rain)}
            <p class="hint">${l('OverrideHint')}</p>
          </fieldset>
          <fieldset>
            <legend>${l('RainBreakHeading')}</legend>
            <div class="bob-field">
              <span>${l('RainBreakLabel')}</span>
              <span class="bob-time-range">
                <input aria-label="${l('RainStart')}" name="rainStart" type="time" value="${clock(cfg.rainBreak?.[0] ?? 780)}">
                ${l('To')}
                <input aria-label="${l('RainEnd')}" name="rainEnd" type="time" value="${clock(cfg.rainBreak?.[1] ?? 870)}">
              </span>
            </div>
          </fieldset>
          <fieldset data-chapter-nine ${getEnvironment().chapter === 9 || cfg.stormEnded ? '' : 'hidden'}>
            <legend>${l('FinalChapter')}</legend>
            ${checkbox('stormEnded', l('StormEndedSetting'), cfg.stormEnded)}
            <p class="hint">${l('StormEndedHint')}</p>
          </fieldset>
        </form>
        <details>
          <summary>${l('CalendarControls')}</summary>
          <div class="bob-toolbar">
            ${button('hold', l('HoldWeather'))}
            ${button('resume', l('ResumeCalendar'))}
          </div>
        </details>
        <fieldset>
          <legend>${l('ActorsAndExceptions')}</legend>
          <div class="bob-toolbar">
            ${button('token', l('TokenSettings'))}
            ${button('actor', l('ChooseActor'))}
          </div>
        </fieldset>
      </section>
    </div>
    <footer class="bob-footer">
      <span data-draft-status role="status">${l('Saved')}</span>
      <div>
        ${button('reload', l('Reload'))}
        ${button('save', l('SaveRules'), 'disabled')}
      </div>
    </footer>
    <p class="bob-feedback" data-feedback role="status"></p>`;
}

function panelClass() {
  return class CompanionPanel extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: 'bob-companion-panel',
      classes: ['bob-companion', 'bob-console'],
      window: { title: 'BoB', resizable: true },
      position: { width: 650, height: 720 },
      tag: 'div'
    };
    constructor(actor) {
      super();
      this.actor = actor;
      this.draft = new RuleDraft(game.settings.get(ID, 'config'));
      this.liveHooks = [];
      this.liveTimer = null;
      this.timeKey = '';
      this.busy = false;
    }
    async _renderHTML() {
      return content(this.draft.value);
    }
    _replaceHTML(result, element) {
      element.innerHTML = result;
    }
    async _onRender(context, options) {
      await super._onRender(context, options);
      this.element.addEventListener('click', (event) => this.onClick(event));
      this.element.addEventListener('input', (event) => this.onInput(event));
      this.element.addEventListener('keydown', (event) => this.onKey(event));
      this.element.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        void this.act('save');
      });
      this.attachHooks();
      this.updateLive();
    }
    attachHooks() {
      if (this.liveHooks.length) return;
      for (const name of [
        'controlToken',
        'updateActor',
        'updateUser',
        'updateScene',
        'updateRegion',
        'canvasReady',
        `${ID}.refresh`,
        `${ID}.calendar`
      ]) {
        this.liveHooks.push([name, Hooks.on(name, () => this.queueLive())]);
      }
      this.liveHooks.push([
        'updateToken',
        Hooks.on('updateToken', (token) => {
          if (
            selected().some(
              (current) => current.id === token.id && current.parent?.id === token.parent?.id
            )
          )
            this.queueLive();
        })
      ]);
      this.liveHooks.push([
        'updateSetting',
        Hooks.on('updateSetting', (setting) => {
          if (
            [
              `${ID}.config`,
              `${ID}.calendar`,
              `${ID}.calendarState`,
              `${OFFICIAL}.campaign`,
              'pf2e.worldClock',
              'calendaria.currentWeather',
              'calendaria.gmOverrideClearsForecast'
            ].includes(setting.key)
          )
            this.queueLive();
        })
      ]);
      this.liveHooks.push([
        'updateWorldTime',
        Hooks.on('updateWorldTime', () => {
          const e = getEnvironment(),
            key = `${e.chapter}:${Math.floor(e.minute)}`;
          if (key !== this.timeKey) {
            this.timeKey = key;
            this.queueLive();
          }
        })
      ]);
    }
    queueLive() {
      if (this.liveTimer || !this.rendered) return;
      this.liveTimer = setTimeout(() => {
        this.liveTimer = null;
        this.updateLive();
      }, 80);
    }
    updateLive() {
      if (!this.element?.isConnected) return;
      if (!game.user?.isGM) {
        void this.close({ discard: true });
        return;
      }
      const tokens = selected(),
        cal = calendarStatus(),
        e = getEnvironment();
      this.timeKey = `${e.chapter}:${Math.floor(e.minute)}`;
      const values = {
        summary: summary(),
        count: l('SelectedCount', { count: tokens.length }),
        selection: selectionSummary(this.actor),
        scene: l('CurrentScene', { name: canvas.scene?.name ?? t('UI.NoScene') }),
        notes: (e.notes ?? []).map((n) => `<li>${escape(n)}</li>`).join(''),
        'calendar-detail': `${escape(cal.detail ?? '')}${cal.overrideUntil ? ` ${l('WeatherHeldUntil', { time: cal.overrideUntil })}` : ''}`
      };
      for (const [name, html] of Object.entries(values)) {
        const target = this.element.querySelector(`[data-live="${name}"]`);
        if (target.innerHTML !== html) target.innerHTML = html;
      }
      for (const target of this.element.querySelectorAll('.bob-exposure button'))
        target.disabled = this.busy || !tokens.length;
      for (const target of this.element.querySelectorAll(
        '[data-bob-action="sync"],[data-bob-action="resume"],[data-bob-action="hold"]'
      ))
        target.disabled = this.busy || !cal.available;
      this.element.querySelector('[data-calendar-prepare]').hidden =
        cal.state !== 'forecast-conflict';
      this.element.querySelector('[data-bob-action="prepare"]').disabled = this.busy;
      this.element.querySelector('[data-chapter-nine]').hidden = !(
        e.chapter === 9 ||
        Number(this.draft.value.chapter) === 9 ||
        this.draft.value.stormEnded
      );
      this.updateDirty();
    }
    updateDirty() {
      this.element.querySelector('[data-draft-status]').textContent = t(
        this.draft.dirty ? 'UI.Unsaved' : 'UI.Saved'
      );
      this.element.querySelector('[data-bob-action="save"]').disabled =
        this.busy || !this.draft.dirty;
    }
    onInput(event) {
      const field = event.target;
      if (!field.closest('.bob-config') || !field.name) return;
      if (field.name.startsWith('rain') && ['rainStart', 'rainEnd'].includes(field.name)) {
        const minutes = (name) => {
          const value = this.element.querySelector(`[name="${name}"]`).value;
          if (!/^\d{2}:\d{2}$/.test(value)) return NaN;
          const [h, m] = value.split(':').map(Number);
          return h * 60 + m;
        };
        this.draft.set('rainBreak', [minutes('rainStart'), minutes('rainEnd')]);
      } else
        this.draft.set(
          field.name,
          field.type === 'checkbox'
            ? field.checked
            : field.name === 'chapter'
              ? Number(field.value)
              : field.value
        );
      this.updateDirty();
      this.element.querySelector('[data-feedback]').textContent = '';
      this.element.querySelector('[data-chapter-nine]').hidden = !(
        getEnvironment().chapter === 9 ||
        Number(this.draft.value.chapter) === 9 ||
        this.draft.value.stormEnded
      );
    }
    tab(name, focus = false) {
      for (const tab of this.element.querySelectorAll('[role="tab"]')) {
        const active = tab.dataset.tab === name;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        if (active && focus) tab.focus();
      }
      for (const pane of this.element.querySelectorAll('[data-pane]'))
        pane.hidden = pane.dataset.pane !== name;
    }
    onKey(event) {
      if (event.target.getAttribute('role') !== 'tab') return;
      const names = ['overview', 'preparation', 'advanced'];
      let i = names.indexOf(event.target.dataset.tab);
      if (event.key === 'ArrowRight') i = (i + 1) % 3;
      else if (event.key === 'ArrowLeft') i = (i + 2) % 3;
      else if (event.key === 'Home') i = 0;
      else if (event.key === 'End') i = 2;
      else return;
      event.preventDefault();
      this.tab(names[i], true);
    }
    onClick(event) {
      const target = event.target.closest('button');
      if (target?.dataset.tab) this.tab(target.dataset.tab);
      else if (target?.dataset.bobAction) void this.act(target.dataset.bobAction);
    }
    async act(action) {
      if (!gmOnly() || this.busy) return;
      this.busy = true;
      this.updateDirty();
      try {
        if (['indoors', 'outdoors', 'auto'].includes(action)) {
          const tokens = selected();
          if (!tokens.length) throw new Error(t('UI.SelectTokenFirst'));
          await applyExposure(tokens, action);
          this.message(t('UI.ExposureUpdated', { count: tokens.length }));
        } else if (action === 'save') {
          await this.draft.save(
            () => game.settings.get(ID, 'config'),
            (value) => game.settings.set(ID, 'config', value)
          );
          this.syncFields();
          this.message(t('UI.RulesSaved'));
        } else if (action === 'reload') {
          if (
            this.draft.dirty &&
            !(await foundry.applications.api.DialogV2.confirm({
              window: { title: t('UI.Reload') },
              content: `<p>${l('ReloadConfirm')}</p>`
            }))
          )
            return;
          this.draft = new RuleDraft(game.settings.get(ID, 'config'));
          this.syncFields();
          this.message(t('UI.Reloaded'));
        } else if (action === 'scene') await configureScene();
        else if (action === 'region') await configureRegion();
        else if (action === 'token') {
          const token = selected()[0];
          if (!token) throw new Error(t('UI.SelectTokenFirst'));
          await configureSubject(token);
        } else if (action === 'actor') await chooseActor();
        else if (action === 'sync') {
          const result = await api().syncCalendar?.({ force: true });
          this.message(result?.error ?? t('UI.CalendarSyncRequested'));
        } else if (action === 'resume') {
          await api().resumeCalendar?.();
          this.message(t('UI.CalendarResumeRequested'));
        } else if (action === 'hold') {
          await api().holdCalendar?.({ until: 'chapter' });
          this.message(t('UI.WeatherHoldRequested'));
        } else if (action === 'prepare') {
          const result = await api().prepareCalendar?.();
          this.message(result?.error ?? t('UI.CalendarPrepareRequested'));
        } else if (action === 'assistants') await api().openAssistants?.();
        else if (action === 'refresh') this.message(t('UI.Refreshed'));
      } catch (error) {
        this.message(t('UI.ActionFailed', { error: error.message }), true);
      } finally {
        this.busy = false;
        this.updateLive();
      }
    }
    syncFields() {
      for (const field of this.element.querySelectorAll('.bob-config [name]')) {
        const value =
          field.name === 'rainStart'
            ? clock(this.draft.value.rainBreak[0])
            : field.name === 'rainEnd'
              ? clock(this.draft.value.rainBreak[1])
              : this.draft.value[field.name];
        if (field.type === 'checkbox') field.checked = Boolean(value);
        else field.value = value;
      }
    }
    message(text, error = false) {
      const target = this.element.querySelector('[data-feedback]');
      target.textContent = text;
      target.classList.toggle('bob-warning', error);
    }
    async close(options = {}) {
      if (
        this.draft.dirty &&
        !options.discard &&
        !(await foundry.applications.api.DialogV2.confirm({
          window: { title: t('UI.CloseTitle') },
          content: `<p>${l('CloseConfirm')}</p>`
        }))
      )
        return this;
      clearTimeout(this.liveTimer);
      for (const [name, id] of this.liveHooks) Hooks.off(name, id);
      this.liveHooks = [];
      const result = await super.close(options);
      if (panel === this) panel = null;
      return result;
    }
  };
}

/** Existing settings, directory button and public API share a single draft-preserving window. */
export async function openPanel(actor) {
  if (!gmOnly()) return;
  if (panel?.rendered) {
    if (actor) panel.actor = actor;
    panel.updateLive();
    panel.bringToFront();
    return panel;
  }
  const Panel = panelClass();
  panel = new Panel(actor);
  await panel.render({ force: true });
  return panel;
}

/** Foundry leaves submit buttons disabled when its callback rejects. Restore them for retry. */
export function createEditorDialog(Base, sourceScene) {
  return class extends Base {
    async _onRender(context, options) {
      await super._onRender(context, options);
      const region = this.element.querySelector('[name="regionId"]');
      if (region)
        region.addEventListener('change', () => {
          this.element.querySelector('[name="exposure"]').value =
            flags(sourceScene?.regions.get(region.value)).exposure ?? 'auto';
        });
    }
    async _onSubmit(...args) {
      const prior = Array.from(this.element.querySelectorAll('button[data-action]'), (button) => [
        button,
        button.disabled
      ]);
      try {
        return await super._onSubmit(...args);
      } catch {
        for (const [button, disabled] of prior) button.disabled = disabled;
        return this;
      }
    }
  };
}
async function editDialog(title, body, save, sourceScene) {
  const Dialog = createEditorDialog(foundry.applications.api.DialogV2, sourceScene);
  return Dialog.wait({
    window: { title },
    position: { width: 530 },
    classes: ['bob-companion'],
    content: body + '<p class="bob-warning" data-save-error role="alert"></p>',
    buttons: [
      {
        action: 'save',
        label: t('UI.Save'),
        default: true,
        callback: async (_event, _button, dialog) => {
          if (!gmOnly()) throw new Error(t('UI.GmOnly'));
          try {
            const data = Object.fromEntries(new FormData(dialog.element.querySelector('form')));
            await save(data);
            return true;
          } catch (error) {
            dialog.element.querySelector('[data-save-error]').textContent = t(
              'UI.DialogSaveFailed',
              { error: error.message }
            );
            throw error;
          }
        }
      }
    ]
  });
}
async function configureScene() {
  const scene = canvas.scene;
  if (!scene) throw new Error(t('UI.LoadSceneFirst'));
  const current = flags(scene);
  return editDialog(
    t('UI.SceneDialogTitle', { name: scene.name }),
    select(
      'scope',
      l('SceneScope'),
      { auto: l('ScopeAuto'), include: l('ScopeInclude'), exclude: l('ScopeExclude') },
      current.scope ?? 'auto'
    ) +
      select('exposure', l('DefaultExposure'), exposureChoices(), current.exposure ?? 'unknown') +
      `<p class="hint">${l('SceneDialogHint')}</p>`,
    (data) =>
      scene.update({ [`flags.${ID}.scope`]: data.scope, [`flags.${ID}.exposure`]: data.exposure })
  );
}
async function configureRegion() {
  const scene = canvas.scene;
  if (!scene?.regions?.size) throw new Error(t('UI.NoRegions'));
  const choices = Object.fromEntries(
    scene.regions.map((r) => [
      r.id,
      t('UI.RegionChoice', {
        name: r.name,
        exposure: exposureChoices()[flags(r).exposure] ?? t('UI.Unmarked')
      })
    ])
  );
  const initial = canvas.regions?.controlled?.[0]?.document?.id ?? Object.keys(choices)[0];
  return editDialog(
    t('UI.RegionDialogTitle', { name: scene.name }),
    select('regionId', l('ChooseRegion'), choices, initial) +
      select(
        'exposure',
        l('RegionExposure'),
        { auto: l('RemoveRegionMark'), ...exposureChoices() },
        flags(scene.regions.get(initial)).exposure ?? 'auto'
      ) +
      `<p class="hint">${l('RegionDialogHint')}</p>`,
    (data) => scene.regions.get(data.regionId).setFlag(ID, 'exposure', data.exposure),
    scene
  );
}
async function chooseActor() {
  const actors = Object.fromEntries(
    game.actors.filter((a) => ['character', 'npc'].includes(a.type)).map((a) => [a.id, a.name])
  );
  const id = await foundry.applications.api.DialogV2.wait({
    window: { title: t('UI.ChooseActor') },
    position: { width: 450 },
    classes: ['bob-companion'],
    content: select('actorId', l('ActorToEdit'), { '': l('ChooseActor'), ...actors }, ''),
    buttons: [
      {
        action: 'choose',
        label: t('UI.OpenSettings'),
        callback: (_e, _b, d) => new FormData(d.element.querySelector('form')).get('actorId')
      }
    ]
  });
  if (id) await configureSubject(game.actors.get(id));
}
async function configureSubject(subject) {
  if (!subject) throw new Error(t('UI.ActorMissing'));
  const current = flags(subject),
    isActor = subject.documentName === 'Actor';
  const scenes = isActor ? Object.fromEntries(game.scenes.map((s) => [s.id, s.name])) : {};
  return editDialog(
    t('UI.SubjectDialogTitle', { name: subject.name }),
    select('role', l('RoleOverride'), roleChoices(), current.role ?? 'auto') +
      select(
        'exposure',
        l('ActualExposure'),
        { auto: l('ExposureAuto'), ...exposureChoices() },
        current.exposure ?? 'auto'
      ) +
      select(
        'perception',
        l('PerceptionMode'),
        {
          auto: l('PerceptionAuto'),
          visual: l('PerceptionVisual'),
          nonvisual: l('PerceptionNonvisual')
        },
        current.perception ?? 'auto'
      ) +
      (isActor
        ? select(
            'sceneId',
            l('UnplacedActorScene'),
            { '': l('NoSceneBinding'), ...scenes },
            current.sceneId ?? ''
          )
        : '') +
      `<p class="hint">${l('SubjectDialogHint')}</p>`,
    (data) =>
      subject.update(
        Object.fromEntries(
          Object.entries(data).map(([key, value]) => [`flags.${ID}.${key}`, value])
        )
      )
  );
}

export function registerUI() {
  class SettingsMenu extends foundry.applications.api.ApplicationV2 {
    render() {
      void openPanel();
      return this;
    }
  }
  game.settings.registerMenu(ID, 'panel', {
    name: t('UI.MenuName'),
    label: t('UI.MenuLabel'),
    hint: t('UI.MenuHint'),
    icon: 'fa-solid fa-moon',
    type: SettingsMenu,
    restricted: true
  });
  Hooks.on('renderActorDirectory', (_app, element) => {
    if (!game.user.isGM || element.querySelector('[data-bob-panel]')) return;
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.dataset.bobPanel = 'true';
    entry.innerHTML = `<i class="fa-solid fa-moon" aria-hidden="true"></i> ${l('DirectoryButton')}`;
    entry.addEventListener('click', () => openPanel());
    (element.querySelector('.directory-header') ?? element).append(entry);
  });
  Hooks.once('ready', () => {
    game.modules.get(ID).api = { ...game.modules.get(ID).api, open: openPanel };
  });
}
