import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INFLUENCE = 140;       // px distance over which magnification fades out
const HIDE_DELAY_MS = 500;   // auto-hide delay after the pointer leaves
const HOT_ZONE_HEIGHT = 3;   // px strip at the screen edge that reveals the dock

export default class MacDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._items = [];
        this._tooltip = null;
        this._rebuildId = 0;
        this._hideTimeoutId = 0;
        this._connections = [];

        this._autoHidden = false;        // pointer is away and dock slid down
        this._fullyAutoHidden = false;   // slide-down animation finished
        this._overviewActive = Main.overview.visible;

        this._readSettings();

        this._dock = new St.BoxLayout({
            style_class: 'macdock-container',
            reactive: true,
            track_hover: true,
        });

        // Thin invisible strip at the bottom edge used to reveal the dock
        this._hotZone = new St.Widget({
            reactive: true,
            track_hover: true,
        });

        Main.layoutManager.addChrome(this._dock, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        Main.layoutManager.addChrome(this._hotZone, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._connect(this._dock, 'notify::width', () => this._reposition());
        this._connect(this._dock, 'notify::height', () => this._reposition());
        this._connect(this._dock, 'motion-event', (_a, event) => this._onMotion(event));
        this._connect(this._dock, 'notify::hover', () => {
            if (!this._dock.hover)
                this._resetScales();
            this._evaluateHover();
        });
        this._connect(this._hotZone, 'notify::hover', () => this._evaluateHover());

        // GNOME's layout manager can force chrome visible again (for example
        // at the end of the overview animation), so re-apply our state.
        this._connect(this._dock, 'notify::visible', () => this._syncVisibility());
        this._connect(this._hotZone, 'notify::visible', () => this._syncVisibility());

        this._connect(Main.layoutManager, 'monitors-changed', () => this._reposition());
        this._connect(this._appSystem, 'app-state-changed', () => this._queueRebuild());
        this._connect(this._appSystem, 'installed-changed', () => this._queueRebuild());
        this._connect(this._favorites, 'changed', () => this._queueRebuild());

        this._connect(Main.overview, 'showing', () => this._setOverviewActive(true));
        this._connect(Main.overview, 'shown', () => this._setOverviewActive(true));
        this._connect(Main.overview, 'hiding', () => this._setOverviewActive(false));
        this._connect(Main.overview, 'hidden', () => this._setOverviewActive(false));

        this._connect(this._settings, 'changed', (_s, key) => this._onSettingChanged(key));

        this._applyStyle();
        this._rebuild();
        this._syncVisibility();
        this._evaluateHover();
    }

    disable() {
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._clearHideTimeout();

        for (const [obj, id] of this._connections)
            obj.disconnect(id);
        this._connections = [];

        this._hideTooltip();

        if (this._dock) {
            Main.layoutManager.removeChrome(this._dock);
            this._dock.destroy();
            this._dock = null;
        }
        if (this._hotZone) {
            Main.layoutManager.removeChrome(this._hotZone);
            this._hotZone.destroy();
            this._hotZone = null;
        }

        this._items = null;
        this._appSystem = null;
        this._favorites = null;
        this._settings = null;
    }

    // ---------------------------------------------------------------- settings

    _readSettings() {
        const s = this._settings;
        this._iconSize = s.get_int('icon-size');
        this._bottomMargin = s.get_int('bottom-margin');
        this._magEnabled = s.get_boolean('magnification-enabled');
        this._magScale = s.get_double('magnification-scale');
        this._showIndicator = s.get_boolean('show-running-indicator');
        this._showTooltips = s.get_boolean('show-tooltips');
        this._autohide = s.get_boolean('autohide');
        this._showInOverview = s.get_boolean('show-in-overview');
    }

    _onSettingChanged(key) {
        const prevIconSize = this._iconSize;
        const prevIndicator = this._showIndicator;
        const prevMagEnabled = this._magEnabled;
        const prevMagScale = this._magScale;

        this._readSettings();
        this._applyStyle();

        if (this._iconSize !== prevIconSize || this._showIndicator !== prevIndicator ||
            this._magEnabled !== prevMagEnabled || this._magScale !== prevMagScale)
            this._rebuild();
        else
            this._reposition();

        if (key === 'autohide') {
            this._clearHideTimeout();
            if (this._autohide)
                this._evaluateHover();
            else
                this._setAutoHidden(false);
        }

        this._syncVisibility();
    }

    _applyStyle() {
        const s = this._settings;
        const padding = s.get_int('dock-padding');
        const opacity = s.get_double('background-opacity');
        const radius = s.get_int('corner-radius');
        const spacing = s.get_int('icon-spacing');

        this._dock.set_style(
            `background-color: rgba(30, 30, 34, ${opacity.toFixed(2)}); ` +
            `border-radius: ${radius}px; ` +
            `padding: 8px ${padding}px 6px ${padding}px; ` +
            `spacing: ${spacing}px;`);
    }

    // -------------------------------------------------------------- visibility

    _setOverviewActive(active) {
        this._overviewActive = active;
        this._hideTooltip();
        this._syncVisibility();
        if (!active)
            this._evaluateHover();
    }

    _syncVisibility() {
        if (!this._dock)
            return;

        const overviewHidden = this._overviewActive && !this._showInOverview;

        const dockVisible = !overviewHidden && !this._fullyAutoHidden;
        if (this._dock.visible !== dockVisible)
            this._dock.visible = dockVisible;

        const zoneVisible = this._autohide && !overviewHidden;
        if (this._hotZone.visible !== zoneVisible)
            this._hotZone.visible = zoneVisible;
    }

    // --------------------------------------------------------------- auto-hide

    _clearHideTimeout() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
    }

    _evaluateHover() {
        if (!this._autohide || !this._dock)
            return;

        this._clearHideTimeout();

        if (this._dock.hover || this._hotZone.hover) {
            this._setAutoHidden(false);
            return;
        }

        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            this._hideTimeoutId = 0;
            this._setAutoHidden(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setAutoHidden(hidden) {
        if (!this._dock || this._autoHidden === hidden)
            return;

        this._autoHidden = hidden;
        this._hideTooltip();

        if (hidden) {
            const offset = this._dock.height + this._bottomMargin + 4;
            this._dock.ease({
                translation_y: offset,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._autoHidden) {
                        this._fullyAutoHidden = true;
                        this._syncVisibility();
                    }
                },
            });
        } else {
            this._fullyAutoHidden = false;
            this._syncVisibility();
            this._dock.ease({
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // ------------------------------------------------------------ build / items

    _connect(obj, signal, callback) {
        this._connections.push([obj, obj.connect(signal, callback)]);
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        this._hideTooltip();
        this._dock.destroy_all_children();
        this._items = [];

        const favApps = this._favorites.getFavorites();
        const favIds = new Set(favApps.map(a => a.get_id()));
        const runningApps = this._appSystem.get_running()
            .filter(a => !favIds.has(a.get_id()));

        for (const app of [...favApps, ...runningApps]) {
            this._addItem({
                label: app.get_name(),
                icon: app.create_icon_texture(this._hiResSize()),
                running: app.state === Shell.AppState.RUNNING,
                onClick: mouseButton => {
                    if (mouseButton === 2)
                        app.open_new_window(-1);   // middle click: new window
                    else
                        app.activate();            // launch or focus
                },
            });
        }

        this._reposition();
    }

    // Icons are loaded at the largest (magnified) size and scaled down at rest,
    // so they stay sharp when the pointer magnifies them.
    _hiResSize() {
        return this._magEnabled
            ? Math.ceil(this._iconSize * this._magScale)
            : this._iconSize;
    }

    _addItem({label, icon, running, onClick}) {
        const size = this._iconSize;
        const hi = this._hiResSize();
        const rest = size / hi;

        const item = new St.BoxLayout({
            vertical: true,
            style_class: 'macdock-item',
        });

        // Fixed-size cell: layout always sees `size` x `size`; the icon inside
        // is larger and may overflow upwards when magnified.
        const cell = new St.Widget({width: size, height: size});
        icon.set_pivot_point(0.5, 1.0);   // grow upwards from the bottom
        icon.set_position(Math.round((size - hi) / 2), size - hi);
        icon.set_scale(rest, rest);
        cell.add_child(icon);

        const button = new St.Button({
            style_class: 'macdock-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            child: cell,
        });
        button.connect('clicked', (_b, mouseButton) => onClick(mouseButton));
        button.connect('notify::hover', () => {
            if (button.hover)
                this._showTooltip(item, label);
            else
                this._hideTooltip();
        });

        const dot = new St.Widget({
            style_class: 'macdock-dot',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: running && this._showIndicator ? 255 : 0,
        });

        item.add_child(button);
        item.add_child(dot);
        this._dock.add_child(item);
        this._items.push({item, icon, rest});
    }

    // ------------------------------------------------------------ magnification

    _onMotion(event) {
        if (!this._magEnabled)
            return Clutter.EVENT_PROPAGATE;

        const [px] = event.get_coords();

        for (const {item, icon, rest} of this._items) {
            const [ix] = item.get_transformed_position();
            const center = ix + item.width / 2;
            const t = Math.max(0, 1 - Math.abs(px - center) / INFLUENCE);
            const eased = t * t * (3 - 2 * t);   // smoothstep
            const scale = rest * (1 + (this._magScale - 1) * eased);

            icon.remove_all_transitions();
            icon.set_scale(scale, scale);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _resetScales() {
        for (const {icon, rest} of this._items ?? []) {
            icon.ease({
                scale_x: rest,
                scale_y: rest,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // ----------------------------------------------------------------- layout

    _reposition() {
        if (!this._dock)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const x = monitor.x + (monitor.width - this._dock.width) / 2;
        const y = monitor.y + monitor.height - this._dock.height - this._bottomMargin;
        this._dock.set_position(Math.round(x), Math.round(y));

        const zoneWidth = Math.max(this._dock.width, 240) + 120;
        this._hotZone.set_size(zoneWidth, HOT_ZONE_HEIGHT);
        this._hotZone.set_position(
            Math.round(monitor.x + (monitor.width - zoneWidth) / 2),
            monitor.y + monitor.height - HOT_ZONE_HEIGHT);
    }

    // ---------------------------------------------------------------- tooltips

    _showTooltip(item, text) {
        this._hideTooltip();
        if (!this._showTooltips)
            return;

        const label = new St.Label({style_class: 'macdock-tooltip', text});
        Main.uiGroup.add_child(label);

        const [x, y] = item.get_transformed_position();
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(-1);
        const lift = this._magEnabled
            ? this._iconSize * (this._magScale - 1) + 10
            : 10;

        label.set_position(
            Math.round(x + item.width / 2 - w / 2),
            Math.round(y - h - lift));
        this._tooltip = label;
    }

    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }
}
