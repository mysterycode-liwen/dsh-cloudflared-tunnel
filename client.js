/**
 * Cloudflared Tunnel Manager — Client half (static DSH bundle).
 * No JSX, no duplicate React, self-contained themed CSS, no external frameworks.
 */
window.__ModuleLoader__.load({
  // Must equal the boot-graph entry id (the package name). A `/client`
  // suffix here registers the factory under a key the loader never looks
  // up, so the sidebar icon and panel silently never appear.
  id: '@local/cloudflared-tunnel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;
    const PANEL = 'cloudflared-tunnel';
    const NS = '@local/cloudflared-tunnel';
    const ROUTE = '/__cloudflared_tunnel__/api';

    function fmtBytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    // Parse the whitespace-aligned `cloudflared tunnel list` table into records.
    // Real column order is  ID  CREATED  NAME (timestamp between id and name).
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const TS_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}[^\s]*|\s+\d{2}:\d{2}:\d{2})?/;
    function parseTunnels(text) {
      const out = [];
      for (const line of String(text || '').split('\n')) {
        const m = line.match(UUID_RE);
        if (!m) continue; // header / note lines have no UUID
        const id = m[0];
        let rest = line.slice(line.indexOf(id) + id.length).trim();
        let created = '';
        const ts = rest.match(TS_RE); // non-global: match carries .index
        if (ts) {
          created = ts[0];
          rest = (rest.slice(0, ts.index) + ' ' + rest.slice(ts.index + ts[0].length)).trim();
        }
        out.push({ id, name: rest.replace(/\s+/g, ' ').trim(), created });
      }
      return out;
    }

    const TABS = [
      ['env', 'tab.env'], ['tunnels', 'tab.tunnels'], ['ingress', 'tab.ingress'], ['quick', 'tab.quick'],
      ['config', 'tab.config'], ['cheatsheet', 'tab.cheatsheet'], ['about', 'tab.about'],
    ];
    const COMMON = [
      { args: 'tunnel list', label: 'tunnel list' },
      { args: 'tunnel info <ID>', label: 'tunnel info' },
      { args: 'tunnel ingress validate', label: 'ingress validate' },
      { args: 'tunnel route dns <ID> <DOMAIN>', label: 'route dns' },
      { args: 'tunnel run <ID>', label: 'tunnel run' },
      { args: '--version', label: 'version' },
    ];

    function CloudIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M18 3.2C10.8 3.2 5 9 5 16.2c0 2.1.5 4.1 1.4 5.9l-2.6 4.5 5.1-.7c2.6 2.4 6 3.8 9.7 3.8 7.2 0 13-5.8 13-13S25.2 3.2 18 3.2z', fill: '#F6821F' }),
        h('path', { d: 'M14.4 12.6a2.3 2.3 0 0 0-2.3 2.3v5.4a2.3 2.3 0 1 0 4.6 0v-5.4a2.3 2.3 0 0 0-2.3-2.3zm7.2 0a2.3 2.3 0 0 0-2.3 2.3v5.4a2.3 2.3 0 1 0 4.6 0v-5.4a2.3 2.3 0 0 0-2.3-2.3z', fill: '#fff' })
      );
    }

    /* Same-origin authenticated Host route. Body/response are small JSON. */
    function call(method, args = {}) {
      return fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      }).then(async (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const r = await res.json();
        return r && typeof r === 'object' ? r : { ok: false, error: 'Invalid host response' };
      });
    }

    function useConfirm(t) {
      const [dialog, setDialog] = useState(null);
      const cancelRef = useRef(null);
      const ask = useCallback((message, action) => setDialog({ message, action }), []);
      const Dialog = useCallback(() => {
        if (!dialog) return null;
        // Escape to dismiss; focus the cancel button on mount for keyboard users.
        useEffect(() => {
          const onKey = (e) => { if (e.key === 'Escape') setDialog(null); };
          document.addEventListener('keydown', onKey);
          if (cancelRef.current) cancelRef.current.focus();
          return () => document.removeEventListener('keydown', onKey);
        }, []);
        return h('div', { className: 'cf-modal-backdrop', onClick: () => setDialog(null) },
          h('div', { className: 'cf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('common.confirmTitle'), onClick: (e) => e.stopPropagation() },
            h('div', { className: 'cf-modal-icon' }, '⛨'),
            h('h3', null, t('common.confirmTitle')),
            h('p', null, dialog.message),
            h('div', { className: 'cf-modal-actions' },
              h('button', { ref: cancelRef, className: 'cf-btn ghost', onClick: () => setDialog(null) }, t('common.cancel')),
              h('button', { className: 'cf-btn primary', onClick: async () => { const a = dialog.action; setDialog(null); await a(); } }, t('common.confirm'))
            )
          )
        );
      }, [dialog, t]);
      return [ask, Dialog];
    }

    function Panel({ locale }) {
      const [, setRev] = useState(0);
      const [tab, setTab] = useState('env');
      const [busy, setBusy] = useState('');
      const [status, setStatus] = useState(null);
      const [login, setLogin] = useState(null);
      const [latest, setLatest] = useState(null);
      const [tunnels, setTunnels] = useState('');
      const [processes, setProcesses] = useState([]);
      const [logs, setLogs] = useState({});
      const [config, setConfig] = useState(null);
      const [ingressTunnel, setIngressTunnel] = useState('');
      const [ingressRules, setIngressRules] = useState([]);
      const [ingressMeta, setIngressMeta] = useState(null);
      const [notice, setNotice] = useState(null);
      const noticeTimer = useRef(null);
      const [installing, setInstalling] = useState(false);
      const [progress, setProgress] = useState(null);
      const [loginResult, setLoginResult] = useState(null);
      const t = useCallback((key) => locale.t(key), [locale]);
      const [askConfirm, ConfirmDialog] = useConfirm(t);

      useEffect(() => {
        const off = locale.subscribe(() => setRev((r) => r + 1));
        return () => { if (off) off(); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
      }, [locale]);

      const notify = useCallback((msg, kind = 'success') => {
        setNotice({ msg, kind });
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(null), 3500);
      }, []);

      const refreshEnv = useCallback(async () => {
        setBusy('env');
        const [s, lg] = await Promise.all([call('status'), call('loginStatus')]);
        if (s.ok) setStatus(s); else notify(s.error, 'error');
        if (lg.ok) setLogin(lg); else notify(lg.error, 'error');
        setBusy('');
      }, [notify]);

      const refreshTunnels = useCallback(async () => {
        setBusy('tunnels');
        const [ls, ps] = await Promise.all([call('listTunnels'), call('listProcesses')]);
        if (ls.ok) setTunnels(ls.output || ''); else notify(ls.error, 'error');
        if (ps.ok) setProcesses(ps.processes || []); else notify(ps.error, 'error');
        setBusy('');
      }, [notify]);

      useEffect(() => { refreshEnv(); }, [refreshEnv]);
      useEffect(() => { if (tab === 'tunnels' || tab === 'ingress' || tab === 'quick') refreshTunnels(); }, [tab, refreshTunnels]);

      // While an install runs, poll the host's progress snapshot and reflect it.
      const installStartedAt = useRef(0);
      useEffect(() => {
        if (!installing) return undefined;
        let alive = true;
        const poll = async () => {
          try {
            const r = await call('installProgress');
            if (!alive) return;
            if (r.ok && r.progress) {
              // Ignore a stale snapshot from a run that finished before this
              // install began.
              if (r.progress.at && r.progress.at < installStartedAt.current) return;
              setProgress(r.progress);
              if (r.progress.state === 'done' || r.progress.state === 'error') {
                setInstalling(false);
                refreshEnv();
              }
            }
          } catch {}
        };
        const timer = setInterval(poll, 400);
        poll();
        return () => { alive = false; clearInterval(timer); };
      }, [installing, refreshEnv]);

      const doAction = useCallback(async (method, args, message, after, quiet = false) => {
        // `quiet` suppresses the generic success toast when `after` already
        // shows a method-specific message (e.g. saveConfig).
        const succeed = (result) => { if (!quiet) notify(t('common.success')); if (after) after(result); };
        try {
          const first = await call(method, args);
          if (first.confirmationRequired) {
            askConfirm(message || t('common.confirm'), async () => {
              const second = await call(method, { ...args, token: first.token, confirmed: true });
              if (!second.ok) return notify(second.error, 'error');
              succeed(second);
            });
            return;
          }
          if (!first.ok) return notify(first.error, 'error');
          succeed(first);
        } catch (err) { notify(String(err), 'error'); }
      }, [askConfirm, notify, t]);

      // Install/upgrade downloads block on the host until finished. Start the
      // progress poll BEFORE the blocking call so live byte progress renders.
      // Only the host can gate (currently only deleteTunnel); if it ever asks
      // for confirmation we honour it, otherwise this is a single download.
      const startDownload = useCallback(async (method) => {
        setProgress(null);
        installStartedAt.current = Date.now();
        setInstalling(true); // start polling before the (blocking) download call
        try {
          const first = await call(method, {});
          if (first.confirmationRequired) {
            askConfirm(t('common.confirm'), async () => {
              const second = await call(method, { token: first.token, confirmed: true });
              if (!second.ok) notify(second.error, 'error');
            });
            return;
          }
          if (!first.ok) notify(first.error, 'error');
          // On success the progress poll sets installing=false and refreshes env.
        } catch (err) { notify(String(err), 'error'); setInstalling(false); }
      }, [call, notify, askConfirm, t]);

      const doInstall = useCallback(() => startDownload('install'), [startDownload]);
      const doUpgrade = useCallback(() => startDownload('update'), [startDownload]);

      // "检查更新" must only CHECK, never download. Compare the installed version
      // with the latest release tag and report — no confirmation, no overwrite.
      const doCheckUpdate = useCallback(async () => {
        setBusy('update');
        try {
          const r = await call('latestVersion');
          setBusy('');
          if (!r.ok) return notify(r.error, 'error');
          setLatest(r.tag);
          const cm = (status && status.version || '').match(/version\s+([\d.]+)/i);
          const current = cm ? cm[1] : '';
          const latestTag = String(r.tag || '').replace(/^v/i, '');
          if (!current) notify(t('env.latest') + ': ' + latestTag);
          else if (current === latestTag) notify(t('env.upToDate'), 'success');
          else notify(t('env.updateFound') + ': ' + latestTag + ' (' + t('env.current') + ' ' + current + ')', 'success');
        } catch (err) { setBusy(''); notify(String(err), 'error'); }
      }, [call, notify, status, t]);

      // Login: run directly so we can surface the returned URL / status instead
      // of hiding everything behind the generic success toast.
      const doLogin = useCallback(() => {
        setBusy('login');
        const finish = async (args) => {
          const r = await call('openLogin', args);
          setBusy('');
          if (r.confirmationRequired) return r;
          if (!r.ok) { notify(r.error, 'error'); return null; }
          setLoginResult(r);
          if (r.loggedIn) notify(t('env.loginYes'), 'success');
          else if (r.message) notify(r.message, r.url ? 'success' : 'error');
          refreshEnv();
          return r;
        };
        // openLogin itself needs no write confirmation, but keep a first call.
        finish({});
      }, [call, notify, refreshEnv, t]);

      return h('div', { className: 'cf-root' },
        h('header', { className: 'cf-header' },
          h('div', { className: 'cf-brand' },
            h('div', { className: 'cf-brand-icon' }, h(CloudIcon, { size: 24 })),
            h('div', null, h('h1', null, t('panel.title')), h('p', null, t('panel.subtitle')))
          ),
          h('button', { className: 'cf-btn ghost', onClick: () => { refreshEnv(); refreshTunnels(); } }, '↻ ' + t('btn.refresh'))
        ),
        h('nav', { className: 'cf-tabs' }, TABS.map(([id, label]) => h('button', {
          key: id, className: 'cf-tab' + (tab === id ? ' active' : ''), onClick: () => setTab(id),
        }, t(label)))),
        h('main', { className: 'cf-content' },
          tab === 'env' && h(EnvTab, { status, login, latest, busy, t, doAction, doInstall, doUpgrade, doCheckUpdate, doLogin, progress, installing, loginResult, notify, refreshEnv, setLatest, call }),
          tab === 'tunnels' && h(TunnelsTab, { tunnels, processes, logs, busy, t, doAction, setTunnels, setLogs, setProcesses, notify, refreshTunnels, call }),
          tab === 'ingress' && h(IngressTab, { tunnels, ingressTunnel, setIngressTunnel, ingressRules, setIngressRules, ingressMeta, setIngressMeta, busy, t, doAction, notify, call }),
          tab === 'quick' && h(QuickTab, { processes, logs, busy, t, doAction, setLogs, refreshTunnels, call, notify }),
          tab === 'config' && h(ConfigTab, { config, t, doAction, setConfig, notify, call }),
          tab === 'cheatsheet' && h(CheatTab, { t, doAction, notify, call }),
          tab === 'about' && h(AboutTab, { t })
        ),
        notice && h('div', { className: 'cf-toast ' + notice.kind }, notice.msg),
        h(ConfirmDialog)
      );
    }

    function Card({ title, children, className = '' }) {
      return h('section', { className: 'cf-card ' + className },
        title ? h('h2', { className: 'cf-card-title' }, title) : null, children);
    }
    function Field({ label, children }) {
      return h('label', { className: 'cf-field' }, h('span', null, label), children);
    }

    function EnvTab({ status, login, latest, busy, t, doAction, doInstall, doUpgrade, doCheckUpdate, doLogin, progress, installing, loginResult, notify, refreshEnv, setLatest, call }) {
      const installed = status && status.installed;
      const busyAll = !!busy || installing;
      return h('div', { className: 'cf-grid' },
        h(Card, { title: t('env.status'), className: 'cf-hero' },
          h('div', { className: 'cf-status-row' },
            h('span', { className: 'cf-badge ' + (installed ? 'good' : 'bad') }, installed ? t('env.installed') : t('env.missing')),
            h('span', { className: 'cf-version' }, status && status.version ? status.version : '—')
          ),
          h('dl', { className: 'cf-dl' },
            h('dt', null, t('env.path')), h('dd', { className: 'cf-mono' }, status ? status.path : '…'),
            h('dt', null, t('env.os')), h('dd', null, status ? status.platform : '…'),
            h('dt', null, t('env.login')), h('dd', null, login ? (login.loggedIn ? t('env.loginYes') : t('env.loginNo')) : '…')
          ),
          (installing && progress) && h('div', { className: 'cf-progress-wrap' },
            h('div', { className: 'cf-progress-label' },
              h('span', null, progress.state === 'done' ? t('env.installDone') : (progress.state === 'error' ? t('env.installFailed') : t('env.downloading'))),
              h('span', null, progress.percent ? progress.percent + '%' : '')
            ),
            h('div', { className: 'cf-progress' }, h('div', { className: 'cf-progress-bar', style: { width: (progress.percent || 0) + '%' } })),
            h('div', { className: 'cf-hint' }, fmtBytes(progress.received) + (progress.total ? ' / ' + fmtBytes(progress.total) : ''))
          ),
          h('div', { className: 'cf-actions' },
            h('button', { className: 'cf-btn primary', disabled: busyAll, onClick: refreshEnv }, t('btn.refresh')),
            !installed && h('button', { className: 'cf-btn', disabled: busyAll, onClick: doInstall }, t('env.install')),
            installed && h('button', { className: 'cf-btn', disabled: busyAll, onClick: doCheckUpdate }, t('env.update')),
            installed && h('button', { className: 'cf-btn', disabled: busyAll, onClick: doUpgrade }, t('env.upgrade')),
            h('button', { className: 'cf-btn', disabled: busyAll, onClick: doLogin }, t('env.loginAction')),
            h('button', { className: 'cf-btn', disabled: busyAll, onClick: () => doAction('openFolder', {}, t('common.confirm')) }, t('btn.openFolder'))
          ),
          !installed && h('p', { className: 'cf-hint' }, t('env.installHint')),
          loginResult && loginResult.url && h('div', { className: 'cf-login-link' },
            h('p', { className: 'cf-hint' }, t('env.loginManual')),
            h('a', { className: 'cf-url', href: loginResult.url, target: '_blank', rel: 'noopener noreferrer' }, loginResult.url)
          )
        ),
        h(Card, { title: t('env.quickVersion') },
          h('button', { className: 'cf-btn', disabled: !!busy, onClick: doCheckUpdate }, t('env.quickVersion')),
          latest && h('p', { className: 'cf-latest' }, t('env.latest') + ': ', h('strong', null, latest)),
          h('p', { className: 'cf-hint' }, t('env.loginHint'))
        )
      );
    }

    function TunnelsTab({ tunnels, processes, logs, busy, t, doAction, setTunnels, setLogs, setProcesses, notify, refreshTunnels, call }) {
      const [name, setName] = useState('');
      const [rowAction, setRowAction] = useState(null); // {id, kind}
      const [value, setValue] = useState('');
      const running = (id) => processes.find((p) => p.kind === 'tunnel' && p.id === id);
      const rows = parseTunnels(tunnels);
      const submitRow = () => {
        if (!rowAction || !value.trim()) return;
        const method = rowAction.kind === 'rename' ? 'renameTunnel' : 'routeDns';
        const payload = rowAction.kind === 'rename' ? { id: rowAction.id, name: value } : { id: rowAction.id, domain: value };
        doAction(method, payload, t('common.confirm'), async () => { setRowAction(null); setValue(''); await refreshTunnels(); });
      };
      return h('div', { className: 'cf-stack' },
        h(Card, { title: t('tunnel.create') },
          h('div', { className: 'cf-inline' },
            h(Field, { label: t('tunnel.name') }, h('input', { className: 'cf-input', value: name, placeholder: t('tunnel.namePlaceholder'), onChange: (e) => setName(e.target.value) })),
            h('button', { className: 'cf-btn primary', disabled: !name.trim() || !!busy, onClick: () => doAction('createTunnel', { name }, t('common.confirm'), async () => { setName(''); await refreshTunnels(); }) }, t('tunnel.create'))
          )
        ),
        h(Card, { title: t('tunnel.list') },
          !tunnels && h('p', { className: 'cf-empty' }, busy ? t('common.loading') : t('tunnel.empty')),
          rows.length === 0 && h('p', { className: 'cf-empty' }, t('tunnel.emptyRaw')),
          rows.length > 0 && h('div', { className: 'cf-tunnel-list' }, rows.map(({ id, name, created }) => {
            const proc = running(id);
            const busyRow = !!busy;
            return h('div', { className: 'cf-tunnel-row' + (proc ? ' is-running' : ''), key: id },
              h('div', { className: 'cf-tunnel-head' },
                h('div', { className: 'cf-tunnel-avatar' }, h(CloudIcon, { size: 22 })),
                h('div', { className: 'cf-tunnel-identity' },
                  h('div', { className: 'cf-tunnel-name' }, name || t('tunnel.unnamed')),
                  h('div', { className: 'cf-tunnel-id', title: id }, id),
                  created && h('div', { className: 'cf-tunnel-created' }, t('tunnel.created') + ': ' + created)
                ),
                h('span', { className: 'cf-badge ' + (proc ? 'good' : 'idle') }, proc ? t('tunnel.running') : t('tunnel.stopped'))
              ),
              h('div', { className: 'cf-actions compact' },
                !proc && h('button', { className: 'cf-btn small', disabled: busyRow, onClick: () => doAction('startTunnel', { id }, t('tunnel.startConfirm'), refreshTunnels) }, t('tunnel.start')),
                proc && h('button', { className: 'cf-btn small danger', disabled: busyRow, onClick: () => doAction('stopProcess', { key: 'tunnel:' + id }, t('common.confirm'), refreshTunnels) }, t('tunnel.stop')),
                h('button', { className: 'cf-btn small', disabled: busyRow, onClick: () => { setRowAction({ id, kind: 'route' }); setValue(''); } }, t('tunnel.route')),
                h('button', { className: 'cf-btn small', disabled: busyRow, onClick: () => { setRowAction({ id, kind: 'rename' }); setValue(''); } }, t('tunnel.rename')),
                h('button', { className: 'cf-btn small danger', disabled: busyRow, onClick: () => doAction('deleteTunnel', { id }, t('tunnel.deleteConfirm'), refreshTunnels) }, t('tunnel.delete'))
              ),
              rowAction && rowAction.id === id && h('div', { className: 'cf-inline row-input' },
                h(Field, { label: t(rowAction.kind === 'rename' ? 'tunnel.newName' : 'tunnel.domain') },
                  h('input', { className: 'cf-input', value: value, autoFocus: true, onChange: (e) => setValue(e.target.value) })),
                h('button', { className: 'cf-btn small primary', onClick: submitRow }, t('common.confirm')),
                h('button', { className: 'cf-btn small', onClick: () => setRowAction(null) }, t('common.cancel'))
              ),
              rowAction && rowAction.kind === 'route' && rowAction.id === id && h('p', { className: 'cf-hint' }, t('tunnel.routeHint')),
              proc && h(TunnelLogs, { id, logs, setLogs, call, t })
            );
          })),
          tunnels && h('details', { className: 'cf-raw-details' },
            h('summary', null, t('tunnel.showRaw')),
            h('pre', { className: 'cf-pre' }, tunnels)
          )
        )
      );
    }

    function TunnelLogs({ id, logs, setLogs, call, t }) {
      useEffect(() => {
        let active = true;
        const timer = setInterval(async () => {
          const r = await call('processLogs', { key: 'tunnel:' + id });
          if (active && r.ok) setLogs((prev) => ({ ...prev, [id]: r.logs }));
        }, 2500);
        return () => { active = false; clearInterval(timer); };
      }, [id]);
      return h('details', { className: 'cf-logs' },
        h('summary', null, t('tunnel.logs')),
        h('pre', { className: 'cf-pre small' }, logs[id] || t('tunnel.noLogs'))
      );
    }

    function IngressTab({ tunnels, ingressTunnel, setIngressTunnel, ingressRules, setIngressRules, ingressMeta, setIngressMeta, busy, t, call, notify }) {
      const rows = parseTunnels(tunnels);
      const [loading, setLoading] = useState(false);
      const [saving, setSaving] = useState(false);

      // Auto-select the first named tunnel once the list has loaded.
      useEffect(() => {
        if (!ingressTunnel && rows.length) setIngressTunnel(rows[0].id);
      }, [tunnels]);

      const loadIngress = async () => {
        if (!ingressTunnel) return;
        setLoading(true);
        try {
          const r = await call('getIngress', { id: ingressTunnel });
          if (!r.ok) return notify(r.error, 'error');
          setIngressRules(JSON.parse(JSON.stringify(r.config?.ingress || [])));
          setIngressMeta({ version: r.version, source: r.source });
        } catch (err) { notify(String(err), 'error'); }
        finally { setLoading(false); }
      };

      const saveIngress = async () => {
        if (!ingressTunnel) return;
        if (!ingressRules.length) return notify(t('ingress.empty'), 'error');
        setSaving(true);
        try {
          const r = await call('setIngress', { id: ingressTunnel, rules: ingressRules });
          if (!r.ok) return notify(r.error, 'error');
          setIngressRules(JSON.parse(JSON.stringify(r.config?.ingress || [])));
          setIngressMeta({ version: r.version, source: 'cloudflare' });
          if (r.restarted) notify(t('ingress.savedRestarted'));
          else if (r.restartError) notify(t('ingress.savedNoRestart') + ' ' + r.restartError, 'error');
          else notify(t('ingress.saved'));
        } catch (err) { notify(String(err), 'error'); }
        finally { setSaving(false); }
      };

      const updateRow = (i, key, value) => setIngressRules((prev) => prev.map((row, idx) => idx === i ? { ...row, [key]: value } : row));
      const addRule = () => setIngressRules((prev) => {
        const next = prev.filter((r) => r.hostname !== undefined); // keep non-catch-all rows
        return [...next, { hostname: '', service: '' }, { hostname: undefined, service: 'http_status:404' }];
      });
      const removeRule = (i) => setIngressRules((prev) => prev.filter((_, idx) => idx !== i));

      const busyAll = loading || saving || !!busy;
      return h('div', { className: 'cf-stack' },
        h(Card, { title: t('ingress.title') },
          h('p', { className: 'cf-hint' }, t('ingress.desc')),
          rows.length === 0
            ? h('p', { className: 'cf-empty' }, t('ingress.noTunnels'))
            : h('div', { className: 'cf-inline' },
              h(Field, { label: t('ingress.selectTunnel') },
                h('select', { className: 'cf-input', value: ingressTunnel, onChange: (e) => { setIngressTunnel(e.target.value); setIngressRules([]); setIngressMeta(null); } },
                  rows.map(({ id, name }) => h('option', { key: id, value: id }, (name || t('tunnel.unnamed')) + '  ·  ' + id))
                )
              ),
              h('button', { className: 'cf-btn primary', disabled: !ingressTunnel || busyAll, onClick: loadIngress }, t('ingress.load'))
            ),
          ingressMeta && h('p', { className: 'cf-hint' },
            (ingressMeta.version != null ? t('ingress.version') + ': ' + ingressMeta.version + '   ' : '') +
            (ingressMeta.source ? t('ingress.source') + ': ' + ingressMeta.source : '')
          )
        ),
        ingressTunnel && h(Card, { title: t('ingress.hostname') + ' → ' + t('ingress.service') },
          h('p', { className: 'cf-hint' }, t('ingress.tip')),
          ingressRules.length === 0 && h('p', { className: 'cf-empty' }, t('ingress.empty')),
          ingressRules.length > 0 && h('div', { className: 'cf-ingress-list' },
            ingressRules.map((row, i) => {
              const isCatchAll = i === ingressRules.length - 1 && !row.hostname;
              return h('div', { className: 'cf-ingress-row' + (isCatchAll ? ' is-catchall' : ''), key: i },
                h('span', { className: 'cf-ingress-index' }, String(i + 1)),
                h('input', {
                  className: 'cf-input', value: row.hostname || '', placeholder: t('ingress.hostPlaceholder'),
                  onChange: (e) => updateRow(i, 'hostname', e.target.value)
                }),
                h('input', {
                  className: 'cf-input', value: row.service || '', placeholder: t('ingress.servicePlaceholder'),
                  onChange: (e) => updateRow(i, 'service', e.target.value)
                }),
                h('input', {
                  className: 'cf-input', value: (row.originRequest && row.originRequest.httpHostHeader) || '', placeholder: t('ingress.hostHeaderPlaceholder'),
                  title: t('ingress.hostHeaderTip'),
                  onChange: (e) => {
                    const v = e.target.value;
                    updateRow(i, 'originRequest', v ? { ...(row.originRequest || {}), httpHostHeader: v } : (() => { const o = { ...(row.originRequest || {}) }; delete o.httpHostHeader; return o; })());
                  }
                }),
                h('button', {
                  className: 'cf-btn small danger', disabled: busyAll || isCatchAll, title: isCatchAll ? t('ingress.catchall') : t('ingress.remove'),
                  onClick: () => removeRule(i)
                }, t('ingress.remove'))
              );
            })
          ),
          h('div', { className: 'cf-actions' },
            h('button', { className: 'cf-btn', disabled: busyAll, onClick: addRule }, t('ingress.add')),
            h('button', { className: 'cf-btn primary', disabled: !ingressRules.length || busyAll, onClick: saveIngress }, t('ingress.save'))
          )
        )
      );
    }

    function QuickTab({ processes, logs, busy, t, doAction, setLogs, refreshTunnels, call, notify }) {
      const [port, setPort] = useState('8080');
      const [host, setHost] = useState('');
      const quick = processes.find((p) => p.kind === 'quick');
      useEffect(() => {
        if (!quick) return;
        let active = true;
        const timer = setInterval(async () => {
          const r = await call('processLogs', { key: 'quick' });
          if (active && r.ok) setLogs((prev) => ({ ...prev, quick: r.logs }));
        }, 2500);
        return () => { active = false; clearInterval(timer); };
      }, [quick]);
      return h('div', { className: 'cf-stack' },
        h(Card, { title: t('quick.title') },
          h('p', { className: 'cf-hint' }, t('quick.desc')),
          h('div', { className: 'cf-inline' },
            h(Field, { label: t('quick.port') }, h('input', { className: 'cf-input', type: 'number', value: port, onChange: (e) => setPort(e.target.value) })),
            h(Field, { label: t('quick.host'), title: t('quick.hostTip') }, h('input', { className: 'cf-input', value: host, placeholder: t('quick.hostPlaceholder'), onChange: (e) => setHost(e.target.value) })),
            !quick && h('button', { className: 'cf-btn primary', disabled: !!busy, onClick: () => doAction('startQuick', { port, host }, t('quick.confirm'), refreshTunnels) }, t('quick.start')),
            quick && h('button', { className: 'cf-btn danger', disabled: !!busy, onClick: () => doAction('stopProcess', { key: 'quick' }, t('common.confirm'), refreshTunnels) }, t('quick.stop'))
          ),
          h('p', { className: 'cf-hint' }, t('quick.disclaimer'))
        ),
        quick && h(Card, { title: t('quick.url') },
          h('div', { className: 'cf-url' }, quick.url || t('common.loading')),
          h('pre', { className: 'cf-pre small' }, logs.quick || t('tunnel.noLogs'))
        )
      );
    }

    function ConfigTab({ config, t, doAction, setConfig, notify, call }) {
      const [draft, setDraft] = useState('');
      useEffect(() => {
        let active = true; // avoid setState after unmount
        call('readConfig').then((r) => {
          if (!active) return;
          if (r.ok) { setConfig(r); setDraft(r.content || ''); }
          else notify(r.error, 'error');
        });
        return () => { active = false; };
      }, []);
      return h(Card, { title: t('config.title') },
        h('p', { className: 'cf-hint' }, t('config.desc')),
        h('textarea', { className: 'cf-textarea', value: draft, onChange: (e) => setDraft(e.target.value), spellCheck: false }),
        h('div', { className: 'cf-actions' },
          h('button', { className: 'cf-btn', onClick: async () => { const r = await call('readConfig'); if (r.ok) { setConfig(r); setDraft(r.content || ''); } else notify(r.error, 'error'); } }, t('config.load')),
          h('button', { className: 'cf-btn primary', onClick: () => doAction('saveConfig', { content: draft }, t('config.confirm'), () => notify(t('config.saved')), true) }, t('config.save'))
        ),
        config && h('p', { className: 'cf-mono hint' }, config.path)
      );
    }

    function CheatTab({ t, doAction, notify, call }) {
      const [args, setArgs] = useState('tunnel list');
      const [out, setOut] = useState('');
      return h('div', { className: 'cf-stack' },
        h(Card, { title: t('cheatsheet.title') },
          h('p', { className: 'cf-hint' }, t('cheatsheet.desc')),
          h('div', { className: 'cf-template-list' }, COMMON.map((c) => h('button', { key: c.args, className: 'cf-template', onClick: () => setArgs(c.args) }, c.label))),
          h('div', { className: 'cf-inline' },
            h(Field, { label: t('cheatsheet.args') }, h('input', { className: 'cf-input mono', value: args, placeholder: t('cheatsheet.argsPlaceholder'), onChange: (e) => setArgs(e.target.value) })),
            h('button', { className: 'cf-btn primary', onClick: () => doAction('exec', { args }, t('cheatsheet.confirmRun'), (r) => setOut(r.output || '')) }, t('cheatsheet.run'))
          )
        ),
        h(Card, { title: t('cheatsheet.output') }, h('pre', { className: 'cf-pre' }, out || t('cheatsheet.empty')))
      );
    }

    function AboutTab({ t }) {
      return h(Card, { title: t('about.title') }, h('p', null, t('about.desc')));
    }

    const css = `
.cf-root{--cf-bg:var(--dsw-alias-bg-base);--cf-panel:var(--dsw-alias-bg-layer-1);--cf-border:var(--dsw-alias-border-l1);--cf-text:var(--dsw-alias-label-primary);--cf-muted:var(--dsw-alias-label-secondary);--cf-brand:var(--dsw-alias-brand-primary);background:var(--cf-bg);color:var(--cf-text);min-height:100%;font-family:inherit;padding:24px 28px 40px;box-sizing:border-box;display:flex;flex-direction:column;gap:18px}
.cf-header{display:flex;align-items:center;justify-content:space-between;gap:16px}
.cf-brand{display:flex;align-items:center;gap:14px}
.cf-brand-icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(246,130,31,.18),rgba(246,130,31,.04));box-shadow:0 4px 16px rgba(246,130,31,.12)}
.cf-brand h1{font-size:20px;font-weight:650;margin:0;letter-spacing:.2px}
.cf-brand p{margin:3px 0 0;font-size:12px;color:var(--cf-muted)}
.cf-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--cf-border);padding-bottom:8px}
.cf-tab{border:0;background:transparent;color:var(--cf-muted);padding:8px 14px;border-radius:10px;font-size:13px;cursor:pointer;transition:.15s}
.cf-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--cf-text)}
.cf-tab.active{background:color-mix(in srgb,var(--cf-brand) 16%,transparent);color:var(--cf-brand);font-weight:600}
.cf-content{flex:1}
.cf-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr);gap:16px}
.cf-stack{display:flex;flex-direction:column;gap:16px}
.cf-card{background:var(--cf-panel);border:1px solid var(--cf-border);border-radius:16px;padding:18px 20px;box-shadow:0 6px 20px rgba(0,0,0,.04)}
.cf-hero{background:linear-gradient(145deg,var(--cf-panel),var(--dsw-alias-bg-layer-2))}
.cf-card-title{font-size:14px;font-weight:650;margin:0 0 14px;display:flex;align-items:center;gap:8px}
.cf-card-title:before{content:"";width:4px;height:15px;border-radius:3px;background:var(--cf-brand)}
.cf-status-row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.cf-badge{font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--cf-border);color:var(--cf-muted);background:var(--dsw-alias-bg-layer-2)}
.cf-badge.good{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.cf-badge.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cf-badge.idle{color:var(--cf-muted)}
.cf-version{font-family:ui-monospace,monospace;font-size:13px;color:var(--cf-text)}
.cf-dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 16px;font-size:12px}
.cf-dl dt{color:var(--cf-muted)}
.cf-dl dd{margin:0;word-break:break-all}
.cf-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.cf-actions{display:flex;gap:8px;flex-wrap:wrap}
.cf-actions.compact{margin-top:10px}
.cf-btn{border:1px solid var(--cf-border);background:var(--dsw-alias-bg-layer-2);color:var(--cf-text);border-radius:9px;padding:8px 13px;font-size:12px;cursor:pointer;transition:.15s}
.cf-btn:hover{border-color:var(--cf-brand);transform:translateY(-1px)}
.cf-btn.primary{background:color-mix(in srgb,var(--cf-brand) 16%,transparent);color:var(--cf-brand);border-color:color-mix(in srgb,var(--cf-brand) 40%,transparent)}
.cf-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cf-btn.ghost{background:transparent}
.cf-btn.small{padding:5px 9px;font-size:11px}
.cf-btn:disabled{opacity:.5;cursor:default;transform:none}
.cf-hint{font-size:11px;color:var(--cf-muted);line-height:1.6}
.cf-progress-wrap{margin:4px 0 14px}
.cf-progress-label{display:flex;justify-content:space-between;font-size:12px;color:var(--cf-text);margin-bottom:6px}
.cf-progress{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--cf-border)}
.cf-progress-bar{height:100%;border-radius:999px;background:var(--cf-brand);transition:width .25s ease}
.cf-login-link{margin-top:12px;padding:12px;border:1px solid var(--cf-border);border-radius:10px;background:var(--cf-bg)}
.cf-login-link .cf-hint{margin:0 0 6px}
.cf-latest{margin-top:12px;font-size:13px}
.cf-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--cf-muted);flex:1;min-width:160px}
.cf-input,.cf-textarea{background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:9px;padding:9px 11px;color:var(--cf-text);font-family:inherit;font-size:12px;outline:none;width:100%;box-sizing:border-box}
.cf-input:focus,.cf-textarea:focus{border-color:var(--cf-brand)}
.cf-textarea{min-height:240px;font-family:ui-monospace,monospace;line-height:1.5;resize:vertical}
.cf-inline{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.cf-inline.row-input{margin-top:10px;padding-top:10px;border-top:1px solid var(--cf-border)}
.cf-pre{background:var(--cf-bg);border:1px solid var(--cf-border);border-radius:10px;padding:12px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;overflow:auto;max-height:300px;margin:0}
.cf-pre.small{max-height:160px}
.cf-empty{color:var(--cf-muted);font-size:12px;padding:18px;text-align:center;border:1px dashed var(--cf-border);border-radius:10px}
.cf-tunnel-list{display:flex;flex-direction:column;gap:12px;margin-top:14px}
.cf-tunnel-row{border:1px solid var(--cf-border);border-radius:14px;padding:16px 18px;background:var(--cf-panel);transition:border-color .15s,box-shadow .15s}
.cf-tunnel-row.is-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--cf-border));box-shadow:0 4px 18px color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.cf-tunnel-head{display:flex;align-items:flex-start;gap:12px}
.cf-tunnel-avatar{width:40px;height:40px;flex:none;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(246,130,31,.18),rgba(246,130,31,.04));border:1px solid color-mix(in srgb,#F6821F 25%,transparent)}
.cf-tunnel-identity{flex:1;min-width:0}
.cf-tunnel-name{font-size:14px;font-weight:650;color:var(--cf-text);line-height:1.3;word-break:break-word}
.cf-tunnel-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--cf-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
.cf-tunnel-created{font-size:11px;color:var(--cf-muted);margin-top:3px}
.cf-tunnel-head .cf-badge{flex:none;white-space:nowrap}
.cf-raw-details{margin-top:14px;font-size:11px;color:var(--cf-muted)}
.cf-raw-details summary{cursor:pointer;user-select:none}
.cf-raw-details .cf-pre{margin-top:8px}
.cf-ingress-list{display:flex;flex-direction:column;gap:10px}
.cf-ingress-row{display:grid;grid-template-columns:26px minmax(0,1fr) minmax(0,1.3fr) minmax(0,.9fr) auto;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--cf-border);border-radius:12px;background:var(--dsw-alias-bg-base)}
.cf-ingress-row.is-catchall{border-style:dashed;border-color:color-mix(in srgb,var(--cf-muted) 45%,var(--cf-border));background:color-mix(in srgb,var(--cf-muted) 6%,var(--cf-panel))}
.cf-ingress-index{width:26px;height:26px;display:grid;place-items:center;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--cf-muted);font-size:12px;font-weight:600}
.cf-ingress-row .cf-input{min-width:0}
.cf-ingress-row.is-catchall .cf-input:first-of-type{opacity:.6;font-style:italic}
.cf-logs{margin-top:10px;font-size:11px;color:var(--cf-muted)}
.cf-logs summary{cursor:pointer}
.cf-url{font-family:ui-monospace,monospace;color:var(--cf-brand);font-size:14px;word-break:break-all;margin-bottom:12px}
.cf-template-list{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.cf-template{font-family:ui-monospace,monospace;font-size:11px;border:1px solid var(--cf-border);background:var(--cf-bg);color:var(--cf-muted);border-radius:8px;padding:6px 10px;cursor:pointer}
.cf-template:hover{border-color:var(--cf-brand);color:var(--cf-text)}
.cf-toast{position:fixed;right:24px;bottom:24px;background:var(--cf-panel);border:1px solid var(--cf-border);border-radius:10px;padding:12px 16px;font-size:12px;box-shadow:0 8px 30px rgba(0,0,0,.2);z-index:50}
.cf-toast.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.cf-toast.success{border-color:var(--dsw-alias-state-success-primary)}
.cf-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:100}
.cf-modal{background:var(--cf-panel);border:1px solid var(--cf-border);border-radius:16px;padding:24px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.cf-modal-icon{font-size:26px;margin-bottom:8px}
.cf-modal h3{margin:0 0 10px;font-size:16px}
.cf-modal p{margin:0 0 20px;font-size:13px;color:var(--cf-muted);line-height:1.6}
.cf-modal-actions{display:flex;justify-content:flex-end;gap:10px}
.cf-root :is(button,a,input,textarea,summary):focus-visible{outline:2px solid var(--cf-brand);outline-offset:2px}
@media(max-width:760px){.cf-grid{grid-template-columns:1fr}.cf-root{padding:16px}}
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const cleanupStyle = ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'cloudflared-tunnel';
          tag.textContent = css;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'cloudflared: styles');

        const zhDict = () => ({
            'sidebar.label': 'Cloudflared', 'tab.env': '环境', 'tab.tunnels': '隧道', 'tab.ingress': 'Ingress 路由', 'tab.quick': '快速隧道', 'tab.config': '配置', 'tab.cheatsheet': '命令速查', 'tab.about': '关于',
            'panel.title': 'Cloudflared 隧道管理', 'panel.subtitle': 'Cloudflare Tunnel / 网络 CLI 控制台',
            'btn.refresh': '刷新', 'btn.openFolder': '打开配置目录',
            'env.status': '运行状态', 'env.version': '版本', 'env.path': '可执行文件路径', 'env.os': '操作系统', 'env.installed': '已安装', 'env.missing': '未安装',
            'env.installHint': '未检测到 cloudflared 二进制。点击下方「安装」下载官方版本，或按提示手动安装。', 'env.install': '安装 CLI', 'env.update': '检查更新',
            'env.upgrade': '升级到最新版', 'env.upToDate': '已是最新版本', 'env.updateFound': '发现新版本', 'env.current': '当前版本',
            'env.login': '登录状态', 'env.loginYes': '已登录（检测到 cert.pem）', 'env.loginNo': '未登录（未找到 cert.pem）', 'env.loginAction': '打开登录页面',
            'env.loginHint': '登录后浏览器会出现一个继续链接，点击后证书会保存到默认目录。', 'env.quickVersion': '查询官方最新版', 'env.latest': '官方最新版',
            'env.downloading': '正在下载 cloudflared…', 'env.installDone': '安装完成', 'env.installFailed': '安装失败', 'env.loginManual': '如果浏览器没有自动打开，请手动打开此链接完成授权：',
            'tunnel.create': '新建隧道', 'tunnel.name': '隧道名称', 'tunnel.namePlaceholder': '例如 my-tunnel', 'tunnel.list': '命名隧道',
            'tunnel.empty': '还没有命名隧道。创建一个开始使用。', 'tunnel.start': '启动', 'tunnel.stop': '停止', 'tunnel.running': '运行中', 'tunnel.stopped': '已停止',
            'tunnel.unnamed': '未命名隧道', 'tunnel.created': '创建于', 'tunnel.showRaw': '查看原始列表', 'tunnel.emptyRaw': '未能解析出隧道，请查看原始列表。',
            'tunnel.route': '配置 DNS 路由', 'tunnel.routeHint': '将域名 CNAME 指向 <隧道ID>.cfargotunnel.com', 'tunnel.domain': '域名（如 tunnel.example.com）',
            'tunnel.rename': '重命名', 'tunnel.newName': '新名称', 'tunnel.delete': '删除隧道', 'tunnel.logs': '运行日志', 'tunnel.noLogs': '暂无日志。',
            'tunnel.deleteConfirm': '确定要删除这条隧道吗？此操作不可撤销。', 'tunnel.renameConfirm': '确定要重命名这条隧道吗？', 'tunnel.startConfirm': '启动隧道会在后台运行 cloudflared。确定继续？',
            'ingress.title': 'Ingress 流量路由', 'ingress.desc': '为域名配置「域名 → 本地服务」的转发规则。这里修改的是 Cloudflare 云端的隧道配置（通过登录凭据调用 API）。注意：还需要为域名配置 DNS 路由（在「隧道」页），请求才能到达隧道。',
            'ingress.selectTunnel': '选择隧道', 'ingress.load': '加载配置', 'ingress.version': '配置版本', 'ingress.source': '配置来源',
            'ingress.hostname': '域名（Hostname）', 'ingress.service': '服务（Service）', 'ingress.hostPlaceholder': '如 home.example.com，留空为兜底规则', 'ingress.servicePlaceholder': '如 http://localhost:5178 或 http_status:404',
            'ingress.hostHeaderPlaceholder': '重写 Host（可选）', 'ingress.hostHeaderTip': '填 localhost 可修复后端报 Invalid Host header；留空则不改写',
            'ingress.add': '添加规则', 'ingress.remove': '删除', 'ingress.save': '保存 Ingress 规则', 'ingress.saveConfirm': '确定要把当前规则保存到 Cloudflare 云端吗？若隧道正在运行，插件会自动重启它使新配置生效。',
            'ingress.saved': 'Ingress 规则已保存', 'ingress.savedRestarted': 'Ingress 已保存，隧道已自动重启并生效', 'ingress.savedNoRestart': 'Ingress 已保存，但隧道重启失败（若隧道正在运行，请手动重启后生效）：', 'ingress.empty': '暂无规则，点击「添加规则」开始。', 'ingress.catchall': '兜底规则（必须最后一条）', 'ingress.tip': '规则从上到下匹配，第一条命中即生效；最后一条必须留空域名（如 http_status:404）。',
            'ingress.noTunnels': '还没有命名隧道，请先在「隧道」页创建。', 'ingress.needLogin': '请先登录 Cloudflare（环境页 → 打开登录页面）。',
            'quick.title': '快速隧道（临时公网地址）', 'quick.desc': '无需登录，立即获得一个 trycloudflare.com 临时域名。适合临时演示与调试；关闭后地址失效。',
            'quick.start': '启动快速隧道', 'quick.port': '本地端口', 'quick.host': '重写 Host（可选）', 'quick.hostPlaceholder': 'localhost', 'quick.hostTip': '填 localhost 可修复后端报 Invalid Host header；填域名或 URL 也可（自动取主机名）', 'quick.url': '公网地址',
            'quick.stop': '停止快速隧道', 'quick.confirm': '启动快速隧道会运行 cloudflared 子进程并暴露本地端口到公网。确定继续？', 'quick.disclaimer': '临时地址由 Cloudflare 自动分配，插件无法自定义域名。',
            'config.title': 'config.yml', 'config.desc': '命名隧道的本地配置文件，通常位于 ~/.cloudflared/config.yml。修改后需重启运行中的隧道。',
            'config.load': '加载配置', 'config.save': '保存配置', 'config.confirm': '确定要覆盖保存 config.yml 吗？请先备份原有内容。', 'config.saved': '配置已保存',
            'cheatsheet.title': '命令速查与安全执行器', 'cheatsheet.desc': '常用 cloudflared 命令。执行采用 argv 数组（不经 shell），有时间与输出长度限制；涉及写入/删除/暴露公网的命令仍需二次确认。',
            'cheatsheet.run': '执行', 'cheatsheet.args': '参数（空格分隔，支持引号）', 'cheatsheet.argsPlaceholder': 'tunnel list', 'cheatsheet.output': '输出', 'cheatsheet.empty': '暂无输出。', 'cheatsheet.confirmRun': '该命令可能改变系统或网络状态，确定执行？',
            'common.confirmTitle': '二次确认', 'common.confirm': '确认', 'common.cancel': '取消', 'common.loading': '加载中…', 'common.success': '成功', 'common.error': '错误',
            'about.title': '关于本插件', 'about.desc': '本插件通过调用本机 cloudflared CLI 管理 Cloudflare Tunnel。所有写操作均需二次确认；Agent 调用工具时同样受此约束。',
          });

        const enDict = () => ({
            'sidebar.label': 'Cloudflared', 'tab.env': 'Environment', 'tab.tunnels': 'Tunnels', 'tab.ingress': 'Ingress', 'tab.quick': 'Quick tunnel', 'tab.config': 'Config', 'tab.cheatsheet': 'Cheat sheet', 'tab.about': 'About',
            'panel.title': 'Cloudflared Tunnel Manager', 'panel.subtitle': 'Cloudflare Tunnel / network CLI console',
            'btn.refresh': 'Refresh', 'btn.openFolder': 'Open config folder',
            'env.status': 'Status', 'env.version': 'Version', 'env.path': 'Executable path', 'env.os': 'Operating system', 'env.installed': 'Installed', 'env.missing': 'Not installed',
            'env.installHint': 'cloudflared binary not found. Click Install to download the official build, or install it manually.', 'env.install': 'Install CLI', 'env.update': 'Check update',
            'env.upgrade': 'Upgrade to latest', 'env.upToDate': 'Already up to date', 'env.updateFound': 'Update available', 'env.current': 'Current',
            'env.login': 'Login', 'env.loginYes': 'Logged in (cert.pem found)', 'env.loginNo': 'Not logged in (cert.pem missing)', 'env.loginAction': 'Open login page',
            'env.loginHint': 'After logging in, open the continue link in your browser; the certificate is saved to the default folder.', 'env.quickVersion': 'Check latest version', 'env.latest': 'Latest',
            'env.downloading': 'Downloading cloudflared…', 'env.installDone': 'Install complete', 'env.installFailed': 'Install failed', 'env.loginManual': 'If the browser did not open automatically, open this link to finish authorization:',
            'tunnel.create': 'Create tunnel', 'tunnel.name': 'Tunnel name', 'tunnel.namePlaceholder': 'e.g. my-tunnel', 'tunnel.list': 'Named tunnels',
            'tunnel.empty': 'No named tunnels yet. Create one to get started.', 'tunnel.start': 'Start', 'tunnel.stop': 'Stop', 'tunnel.running': 'Running', 'tunnel.stopped': 'Stopped',
            'tunnel.unnamed': 'Unnamed tunnel', 'tunnel.created': 'Created', 'tunnel.showRaw': 'Show raw list', 'tunnel.emptyRaw': 'Could not parse tunnels; see the raw list.',
            'tunnel.route': 'DNS route', 'tunnel.routeHint': 'Point the domain CNAME to <ID>.cfargotunnel.com', 'tunnel.domain': 'Domain (e.g. tunnel.example.com)',
            'tunnel.rename': 'Rename', 'tunnel.newName': 'New name', 'tunnel.delete': 'Delete', 'tunnel.logs': 'Logs', 'tunnel.noLogs': 'No logs yet.',
            'tunnel.deleteConfirm': 'Delete this tunnel? This cannot be undone.', 'tunnel.renameConfirm': 'Rename this tunnel?', 'tunnel.startConfirm': 'Starting a tunnel runs cloudflared in the background. Continue?',
            'ingress.title': 'Ingress routing', 'ingress.desc': 'Configure hostname → local-service forwarding rules. Changes are made to the tunnel config in Cloudflare (via the login credentials). You also need a DNS route (Tunnels tab) for requests to reach the tunnel.',
            'ingress.selectTunnel': 'Select tunnel', 'ingress.load': 'Load config', 'ingress.version': 'Config version', 'ingress.source': 'Source',
            'ingress.hostname': 'Hostname', 'ingress.service': 'Service', 'ingress.hostPlaceholder': 'e.g. home.example.com; empty = catch-all', 'ingress.servicePlaceholder': 'e.g. http://localhost:5178 or http_status:404',
            'ingress.hostHeaderPlaceholder': 'Override Host (optional)', 'ingress.hostHeaderTip': 'Set localhost to fix "Invalid Host header" from the backend; leave empty to keep original Host',
            'ingress.add': 'Add rule', 'ingress.remove': 'Remove', 'ingress.save': 'Save ingress rules', 'ingress.saveConfirm': 'Save these rules to the Cloudflare cloud? If the tunnel is running, the plugin will restart it to apply the new config.',
            'ingress.saved': 'Ingress rules saved', 'ingress.savedRestarted': 'Ingress saved; tunnel restarted and applied', 'ingress.savedNoRestart': 'Ingress saved, but tunnel restart failed (restart manually if the tunnel is running):', 'ingress.empty': 'No rules yet. Click "Add rule" to start.', 'ingress.catchall': 'Catch-all rule (must be last)', 'ingress.tip': 'Rules match top-to-bottom, first hit wins. The last rule must have an empty hostname (e.g. http_status:404).',
            'ingress.noTunnels': 'No named tunnels yet — create one on the Tunnels tab first.', 'ingress.needLogin': 'Please log in to Cloudflare first (Environment → Open login page).',
            'quick.title': 'Quick tunnel (temporary public URL)', 'quick.desc': 'No login needed — get a temporary trycloudflare.com domain instantly. Great for demos and debugging; the URL dies when stopped.',
            'quick.start': 'Start quick tunnel', 'quick.port': 'Local port', 'quick.host': 'Override Host (optional)', 'quick.hostPlaceholder': 'localhost', 'quick.hostTip': 'Set localhost to fix "Invalid Host header" from the backend; a domain or URL also works (hostname is extracted)', 'quick.url': 'Public URL',
            'quick.stop': 'Stop quick tunnel', 'quick.confirm': 'Starting a quick tunnel runs cloudflared and exposes a local port to the internet. Continue?', 'quick.disclaimer': 'The temporary domain is assigned by Cloudflare and cannot be customized.',
            'config.title': 'config.yml', 'config.desc': 'Local config for named tunnels, usually ~/.cloudflared/config.yml. Restart running tunnels after changes.',
            'config.load': 'Reload', 'config.save': 'Save', 'config.confirm': 'Overwrite config.yml? Back up the current content first.', 'config.saved': 'Config saved',
            'cheatsheet.title': 'Command cheat sheet & safe executor', 'cheatsheet.desc': 'Common cloudflared commands. Runs via argv (no shell), with time and output limits; write/delete/expose commands still require a second confirmation.',
            'cheatsheet.run': 'Run', 'cheatsheet.args': 'Arguments (space separated, quotes supported)', 'cheatsheet.argsPlaceholder': 'tunnel list', 'cheatsheet.output': 'Output', 'cheatsheet.empty': 'No output.', 'cheatsheet.confirmRun': 'This command may change system or network state. Run it?',
            'common.confirmTitle': 'Second confirmation', 'common.confirm': 'Confirm', 'common.cancel': 'Cancel', 'common.loading': 'Loading…', 'common.success': 'Success', 'common.error': 'Error',
            'about.title': 'About this plugin', 'about.desc': 'This plugin manages Cloudflare Tunnels through the local cloudflared CLI. Every write requires a second confirmation — including Agent tool calls.',
        });

        // Register both locales so the plugin manager can localize its metadata,
        // but pin this panel's visible UI to Chinese regardless of Harness locale.
        ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }), 'cloudflared: locale dictionaries');

        const localeFace = {
          t: (key, params) => {
            const dict = zhDict();
            let value = dict[key];
            if (value === undefined) value = ctx.locale.bind(NS)(key, params);
            if (typeof value === 'function') value = value(params);
            return value !== undefined ? String(value) : key;
          },
          subscribe: (fn) => ctx.locale.subscribe(fn),
        };

        function Icon() {
          return h('div', { style: { width: 20, height: 20, display: 'grid', placeItems: 'center' } }, h(CloudIcon, { size: 18 }));
        }
        const cleanupMain = ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL, id: 'cloudflared-tunnel-panel', order: 90 },
          () => h(Panel, { locale: localeFace })
        ));
        const cleanupIcon = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL, order: 90, label: () => zhDict()['sidebar.label'] || 'Cloudflared' },
          Icon
        ));
        // effect() calls the callback immediately and collects its RETURN value
        // as the disposer. Registering happened above via inject(); here we only
        // return the teardown so it runs on unload — not right now.
        ctx.effect(() => () => {
          cleanupMain();
          cleanupIcon();
          cleanupStyle();
        }, 'cloudflared: ui cleanup');
      },
    };
  },
});
