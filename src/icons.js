(() => {
  const namespace = 'http://www.w3.org/2000/svg';
  const shapes = {
    truck: [['path', { d: 'M3 5h11v12H3zM14 9h4l3 4v4h-7' }], ['circle', { cx: '7', cy: '18', r: '2' }], ['circle', { cx: '18', cy: '18', r: '2' }]],
    ambulance: [['path', { d: 'M3 7h11v11H3zM14 10h4l3 4v4h-7M7 10v5M4.5 12.5h5M16 11v4h4' }], ['circle', { cx: '7', cy: '18', r: '2' }], ['circle', { cx: '18', cy: '18', r: '2' }]],
    route: [['circle', { cx: '5', cy: '5', r: '2' }], ['circle', { cx: '19', cy: '19', r: '2' }], ['path', { d: 'M7 5h9a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8h5M5 7v3M19 17v-3' }]],
    clipboard: [['rect', { x: '5', y: '5', width: '14', height: '16', rx: '2' }], ['rect', { x: '9', y: '3', width: '6', height: '4', rx: '1' }], ['path', { d: 'M9 12h6M9 16h6' }]],
    users: [['circle', { cx: '9', cy: '8', r: '3' }], ['path', { d: 'M3 21v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-4-5.65' }]],
    chart: [['path', { d: 'M3 3v18h18M7 16v-5M12 16V7M17 16V4' }]],
    logout: [['path', { d: 'M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M14 8l4 4-4 4M8 12h13' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    search: [['circle', { cx: '10.5', cy: '10.5', r: '6.5' }], ['path', { d: 'm16 16 5 5' }]],
    refresh: [['path', { d: 'M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M16 16h5v5' }]],
    package: [['path', { d: 'm12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5' }]],
    pin: [['path', { d: 'M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z' }], ['circle', { cx: '12', cy: '10', r: '2.5' }]],
    clock: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3 2' }]],
    check: [['path', { d: 'm5 12 4 4L19 6' }]],
    x: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
    shield: [['path', { d: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z' }], ['path', { d: 'm8 12 3 3 5-6' }]],
    chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
    'chevron-right': [['path', { d: 'm9 6 6 6-6 6' }]],
    building: [['rect', { x: '5', y: '3', width: '14', height: '18', rx: '1' }], ['path', { d: 'M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-6h4v6' }]],
    mail: [['rect', { x: '3', y: '5', width: '18', height: '14', rx: '2' }], ['path', { d: 'm3 6 9 7 9-7' }]],
    user: [['circle', { cx: '12', cy: '7', r: '4' }], ['path', { d: 'M4 21v-2a8 8 0 0 1 16 0v2' }]],
    key: [['circle', { cx: '8', cy: '8', r: '5' }], ['path', { d: 'm11.5 11.5 9 9M16 16l3-3M19 19l3-3' }]],
    'arrow-right': [['path', { d: 'M4 12h16m-6-6 6 6-6 6' }]],
    send: [['path', { d: 'm22 2-7 20-4-9L2 9l20-7ZM11 13 22 2' }]],
    trash: [['path', { d: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7' }]],
    filter: [['path', { d: 'M3 4h18l-7 8v7l-4 2v-9L3 4Z' }]],
    alert: [['path', { d: 'm12 3 10 18H2L12 3ZM12 9v5M12 17h.01' }]],
    info: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 11v6M12 7h.01' }]],
    'check-circle': [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'm8 12 3 3 5-6' }]],
    calendar: [['rect', { x: '3', y: '5', width: '18', height: '16', rx: '2' }], ['path', { d: 'M16 3v4M8 3v4M3 11h18' }]],
    download: [['path', { d: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5' }]],
    menu: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
    eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
  };

  const create = (name, className = '') => {
    const iconName = Object.hasOwn(shapes, name) ? name : 'clipboard';
    const svg = document.createElementNS(namespace, 'svg');
    const attributes = {
      width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false', 'data-icon-name': iconName,
      class: `icon${typeof className === 'string' && className.trim() ? ` ${className.trim()}` : ''}`,
    };
    Object.entries(attributes).forEach(([key, value]) => svg.setAttribute(key, value));
    shapes[iconName].forEach(([tag, values]) => {
      const shape = document.createElementNS(namespace, tag);
      Object.entries(values).forEach(([key, value]) => shape.setAttribute(key, value));
      svg.append(shape);
    });
    return svg;
  };

  const hydrate = (root = document) => {
    root.querySelectorAll('span[data-icon]').forEach((placeholder) => {
      Array.from(placeholder.children).forEach((child) => {
        if (child.namespaceURI === namespace && child.localName === 'svg') child.remove();
      });
      placeholder.append(create(placeholder.dataset.icon));
    });
  };

  window.AmbulanceIcons = Object.freeze({ create, hydrate });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrate(), { once: true });
  } else {
    hydrate();
  }
})();
