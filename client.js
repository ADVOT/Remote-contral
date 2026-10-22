window.__ModuleLoader__.load({
  id: '@local/dsh-connect',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The connection manager is local-only; paired browsers use the ordinary DSH UI.
        const desktop = window.location.protocol === 'dsh-app:' && window.location.hostname === 'app';
        const remote = !desktop && window.__DSH_CONNECT_LOCAL_ORIGIN__ && window.location.origin !== window.__DSH_CONNECT_LOCAL_ORIGIN__;
        const zh = String(ctx.locale.getSnapshot().active).startsWith('zh');
        function Icon() {
          return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
            h('rect', { x: 2, y: 4, width: 13, height: 10, rx: 2 }), h('path', { d: 'M5 18h7m-3.5-4v4' }),
            h('rect', { x: 15, y: 10, width: 7, height: 12, rx: 2 }));
        }
        function Panel() {
          return h('iframe', { src: remote ? '/__dsh_connect/login' : '/dsh-connect/console', title: remote ? '连接账号' : zh ? '连接' : 'Connections', style: { display: 'block', width: '100%', height: '100%', minHeight: 560, border: 0, background: '#0d1020' } });
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-connect', order: 24, label: () => remote ? (zh ? '连接账号' : 'Connection account') : zh ? '连接' : 'Connections' }, Icon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-connect' }, Panel));
      },
    };
  },
});
