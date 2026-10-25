import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ICON_SIZE = 48;       // base icon size in px
const MAX_SCALE = 1.5;      // magnification of the icon under the pointer
const INFLUENCE = 140;      // px distance over which magnification fades out
const BOTTOM_MARGIN = 10;   // gap between dock and screen edge

export default class MacDockExtension extends Extension {
    enable() {
        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._items = [];
        this._tooltip = null;
        this._rebuildId = 0;
        this._connections = [];

        this._dock = new St.BoxLayout({
            style_class: 'macdock-container',
            reactive: true,
            track_hover: true,
        });

        Main.layoutManager.addChrome(this._dock, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._connect(this._dock, 'notify::width', () => this._reposition());
        this._connect(this._dock, 'notify::height', () => this._reposition());
        this._connect(this._dock, 'motion-event', (_a, event) => this._onMotion(event));
        this._connect(this._dock, 'notify::hover', () => {
            if (!this._dock.hover)
                this._resetScales();
        });

        this._connect(Main.layoutManager, 'monitors-changed', () => this._reposition());
        this._connect(this._appSystem, 'app-state-changed', () => this._queueRebuild());
        this._connect(this._appSystem, 'installed-changed', () => this._queueRebuild());
        this._connect(this._favorites, 'changed', () => this._queueRebuild());

        // Hide the dock while the Activities overview is open
        this._connect(Main.overview, 'showing', () => this._dock.hide());
        this._connect(Main.overview, 'hiding', () => this._dock.show());

        this._rebuild();
    }

    disable() {
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }

        for (const [obj, id] of this._connections)
            obj.disconnect(id);
        this._connections = [];

        this._hideTooltip();

        if (this._dock) {
            Main.layoutManager.removeChrome(this._dock);
            this._dock.destroy();
            this._dock = null;
        }

        this._items = null;
        this._appSystem = null;
        this._favorites = null;
    }

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
                child: app.create_icon_texture(ICON_SIZE),
                running: app.state === Shell.AppState.RUNNING,
                onClick: mouseButton => {
                    if (mouseButton === 2)
                        app.open_new_window(-1);   // middle click: new window
                    else
                        app.activate();            // launch or focus
                },
            });
        }

        // "Show Applications" button at the end (like Launchpad)
        this._addItem({
            label: 'Show Applications',
            child: new St.Icon({
                icon_name: 'view-app-grid-symbolic',
                icon_size: Math.round(ICON_SIZE * 0.7),
                style_class: 'macdock-grid-icon',
            }),
            running: false,
            onClick: () => Main.overview.showApps(),
        });

        this._reposition();
    }

    _addItem({label, child, running, onClick}) {
        const item = new St.BoxLayout({
            vertical: true,
            style_class: 'macdock-item',
        });

        const button = new St.Button({
            style_class: 'macdock-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            child,
        });
        button.set_pivot_point(0.5, 1.0);   // grow upwards from the bottom
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
            opacity: running ? 255 : 0,
        });

        item.add_child(button);
        item.add_child(dot);
        this._dock.add_child(item);
        this._items.push({item, button});
    }

    _onMotion(event) {
        const [px] = event.get_coords();

        for (const {item, button} of this._items) {
            const [ix] = item.get_transformed_position();
            const center = ix + item.width / 2;
            const t = Math.max(0, 1 - Math.abs(px - center) / INFLUENCE);
            const eased = t * t * (3 - 2 * t);   // smoothstep
            const scale = 1 + (MAX_SCALE - 1) * eased;

            button.remove_all_transitions();
            button.set_scale(scale, scale);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _resetScales() {
        for (const {button} of this._items ?? []) {
            button.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _reposition() {
        if (!this._dock)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const x = monitor.x + (monitor.width - this._dock.width) / 2;
        const y = monitor.y + monitor.height - this._dock.height - BOTTOM_MARGIN;
        this._dock.set_position(Math.round(x), Math.round(y));
    }

    _showTooltip(item, text) {
        this._hideTooltip();

        const label = new St.Label({style_class: 'macdock-tooltip', text});
        Main.uiGroup.add_child(label);

        const [x, y] = item.get_transformed_position();
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(-1);
        const lift = ICON_SIZE * (MAX_SCALE - 1) + 10;

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
