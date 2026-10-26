import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INFLUENCE = 140;       // px distance over which magnification fades out
const HIDE_DELAY_MS = 500;   // auto-hide delay after the pointer leaves
const HOT_ZONE_HEIGHT = 3;   // px strip at the screen edge that reveals the dock
const PREVIEW_DELAY_MS = 450;   // hover time before the window preview opens
const PREVIEW_CLOSE_MS = 250;   // grace time before the preview closes
const THUMB_W = 200;            // window thumbnail size
const THUMB_H = 125;

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

        this._dragging = false;
        this._menuOpen = false;
        this._menuRec = null;
        this._previewRec = null;
        this._previewTimeoutId = 0;
        this._previewCloseId = 0;
        this._dropMarker = null;
        this._trashFull = false;
        this._trashFile = null;
        this._trashMonitor = null;
        this._cancellable = new Gio.Cancellable();

        this._autoHidden = false;        // pointer is away and dock slid down
        this._fullyAutoHidden = false;   // slide-down animation finished
        this._overviewActive = Main.overview.visible;

        this._readSettings();

        this._dock = new St.BoxLayout({
            style_class: 'macdock-container',
            reactive: true,
            track_hover: true,
        });

        this._menuManager = new PopupMenu.PopupMenuManager(this._dock);

        // Drop target for re-ordering / pinning apps by dragging
        this._dock._delegate = {
            handleDragOver: (source, _actor, x) => {
                try {
                    const app = this._dropApp(source);
                    if (!app)
                        return DND.DragMotionResult.CONTINUE;
                    this._showDropMarker(this._computeDrop(x, app.get_id()).gap);
                    return DND.DragMotionResult.MOVE_DROP;
                } catch (err) {
                    console.error(`${this.uuid}: drag over: ${err.message}`);
                    return DND.DragMotionResult.NO_DROP;
                }
            },
            acceptDrop: (source, _actor, x) => {
                try {
                    this._hideDropMarker();
                    const app = this._dropApp(source);
                    if (!app)
                        return false;
                    const id = app.get_id();
                    const {index} = this._computeDrop(x, id);
                    if (this._favorites.isFavorite(id))
                        this._favorites.moveFavoriteToPos(id, index);
                    else
                        this._favorites.addFavoriteAtPos(id, index);
                    return true;
                } catch (err) {
                    console.error(`${this.uuid}: drop: ${err.message}`);
                    return false;
                }
            },
        };

        // Dropping a pinned app on the Trash unpins it
        this._trashDelegate = {
            handleDragOver: source => {
                const app = this._dropApp(source);
                if (!app)
                    return DND.DragMotionResult.CONTINUE;
                this._hideDropMarker();
                return this._favorites.isFavorite(app.get_id())
                    ? DND.DragMotionResult.MOVE_DROP
                    : DND.DragMotionResult.NO_DROP;
            },
            acceptDrop: source => {
                const app = this._dropApp(source);
                if (!app || !this._favorites.isFavorite(app.get_id()))
                    return false;
                this._favorites.removeFavorite(app.get_id());
                return true;
            },
        };

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

        // Follow the GNOME light/dark theme for the menu and previews
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._connect(this._interface, 'changed::color-scheme', () => this._refreshThemes());
        this._connect(this._interface, 'changed::gtk-theme', () => this._refreshThemes());

        // GNOME's built-in dash in the overview: keep it hidden if requested
        this._dashSaved = null;
        this._syncingDash = false;
        if (Main.overview.dash) {
            this._connect(Main.overview.dash, 'notify::visible', () => this._syncDefaultDash());
            this._connect(Main.overview.dash, 'notify::opacity', () => this._syncDefaultDash());
        }
        this._syncDefaultDash();

        this._setupTrashMonitor();

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

        this._closeMenu();
        this._menuManager = null;
        this._hidePreview();
        this._interface = null;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._trashMonitor) {
            this._trashMonitor.cancel();
            this._trashMonitor = null;
        }
        this._trashFile = null;
        this._hideDropMarker();

        // Give GNOME's own dash back
        this._hideDefaultDash = false;
        this._syncDefaultDash();

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
        this._hideDefaultDash = s.get_boolean('hide-default-dash');
        this._minimizeOnClick = s.get_boolean('minimize-on-click');
        this._hoverPreview = s.get_boolean('hover-preview');
    }

    _onSettingChanged(key) {
        const prevIconSize = this._iconSize;
        const prevIndicator = this._showIndicator;
        const prevMagEnabled = this._magEnabled;
        const prevMagScale = this._magScale;

        this._readSettings();
        this._applyStyle();

        if (!this._hoverPreview)
            this._hidePreview();

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

        this._syncDefaultDash();
        this._syncVisibility();
    }

    // Hides GNOME's built-in overview dash. Several measures are combined so
    // that it stays hidden even if the shell tries to show it again:
    // hidden, zero height (no gap), clipped, transparent, not clickable.
    _syncDefaultDash() {
        const dash = Main.overview.dash;
        if (!dash || this._syncingDash)
            return;

        this._syncingDash = true;
        try {
            if (this._hideDefaultDash) {
                if (!this._dashSaved) {
                    this._dashSaved = {
                        opacity: dash.opacity,
                        reactive: dash.reactive,
                        clip: dash.clip_to_allocation,
                    };
                }
                dash.clip_to_allocation = true;
                dash.set_height(0);
                dash.opacity = 0;
                dash.reactive = false;
                if (dash.visible)
                    dash.hide();
            } else if (this._dashSaved) {
                const saved = this._dashSaved;
                this._dashSaved = null;
                dash.set_height(-1);
                dash.clip_to_allocation = saved.clip;
                dash.opacity = saved.opacity;
                dash.reactive = saved.reactive;
                if (!dash.visible)
                    dash.show();
            }
        } finally {
            this._syncingDash = false;
        }
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
        this._hidePreview();
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

        if (this._dragging || this._menuOpen || this._dock.hover || this._hotZone.hover ||
            this._previewRec?.actor.hover) {
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
        if (hidden)
            this._hidePreview();

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
        this._hidePreview();
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
                app,
                isFavorite: favIds.has(app.get_id()),
                onClick: (mouseButton, button) => {
                    if (mouseButton === 3)
                        this._showMenu(button, app);       // right click: menu
                    else if (mouseButton === 2)
                        app.open_new_window(-1);           // middle click: new window
                    else
                        this._activateApp(app);            // open / focus / minimize
                },
            });
        }

        // The Trash is always the last item, so newly opened or pinned apps
        // are added to its left and never push it around.
        const trash = this._addItem({
            label: 'Trash',
            icon: new St.Icon({
                icon_name: this._trashFull ? 'user-trash-full' : 'user-trash',
                icon_size: this._hiResSize(),
            }),
            running: false,
            onClick: mouseButton => {
                if (mouseButton === 1)
                    this._openTrash();
            },
        });
        trash.button._delegate = this._trashDelegate;

        this._reposition();
    }

    // Icons are loaded at the largest (magnified) size and scaled down at rest,
    // so they stay sharp when the pointer magnifies them.
    _hiResSize() {
        return this._magEnabled
            ? Math.ceil(this._iconSize * this._magScale)
            : this._iconSize;
    }

    _addItem({label, icon, running, onClick, app = null, isFavorite = false}) {
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
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            child: cell,
        });
        button.connect('clicked', (_b, mouseButton) => onClick(mouseButton, button));
        button.connect('notify::hover', () => {
            if (button.hover) {
                this._showTooltip(item, label);
                if (app)
                    this._schedulePreview(item, app);
            } else {
                this._hideTooltip();
                if (app)
                    this._scheduleClosePreview();
            }
        });

        const dot = new St.Widget({
            style_class: 'macdock-dot',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: running && this._showIndicator ? 255 : 0,
        });

        item.add_child(button);
        item.add_child(dot);
        this._dock.add_child(item);

        if (app)
            this._makeDraggable(button, item, app);

        this._items.push({item, icon, rest, appId: app ? app.get_id() : null, isFavorite});
        return {item, button};
    }

    // ----------------------------------------------- light / dark theme

    _isDark() {
        const scheme = this._interface.get_string('color-scheme');
        if (scheme === 'prefer-dark')
            return true;
        if (scheme === 'prefer-light')
            return false;
        return this._interface.get_string('gtk-theme').toLowerCase().includes('dark');
    }

    _applyTheme(actor) {
        actor.remove_style_class_name('macdock-theme-dark');
        actor.remove_style_class_name('macdock-theme-light');
        actor.add_style_class_name(this._isDark() ? 'macdock-theme-dark' : 'macdock-theme-light');
    }

    _refreshThemes() {
        if (this._menuRec)
            this._applyTheme(this._menuRec.menu.actor);
        if (this._previewRec)
            this._applyTheme(this._previewRec.actor);
    }

    // ------------------------------------------------------- click action

    // Not running: open. Running but not in front: bring to front.
    // Running and in front: minimize (if enabled).
    _activateApp(app) {
        this._hidePreview();

        const windows = app.get_windows();
        if (this._minimizeOnClick && app.state === Shell.AppState.RUNNING &&
            windows.length > 0 && !Main.overview.visible) {
            const tracker = Shell.WindowTracker.get_default();
            if (tracker.focus_app === app) {
                const workspace = global.workspace_manager.get_active_workspace();
                const toMinimize = windows.filter(w =>
                    !w.minimized &&
                    w.can_minimize() &&
                    w.get_window_type() === Meta.WindowType.NORMAL &&
                    w.located_on_workspace(workspace));
                if (toMinimize.length > 0) {
                    toMinimize.forEach(w => w.minimize());
                    return;
                }
            }
        }

        app.activate();
    }

    // ------------------------------------------------- hover window preview

    _schedulePreview(item, app) {
        this._cancelClosePreview();
        this._cancelPendingPreview();

        if (!this._hoverPreview || this._dragging || this._menuOpen)
            return;

        const hasWindows = app.state === Shell.AppState.RUNNING &&
            app.get_windows().length > 0;
        if (!hasWindows) {
            this._destroyPreview();
            return;
        }

        // Moving between icons while a preview is open switches instantly
        if (this._previewRec) {
            this._showPreview(item, app);
            return;
        }

        this._previewTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_DELAY_MS, () => {
            this._previewTimeoutId = 0;
            this._showPreview(item, app);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPendingPreview() {
        if (this._previewTimeoutId) {
            GLib.source_remove(this._previewTimeoutId);
            this._previewTimeoutId = 0;
        }
    }

    _cancelClosePreview() {
        if (this._previewCloseId) {
            GLib.source_remove(this._previewCloseId);
            this._previewCloseId = 0;
        }
    }

    _scheduleClosePreview() {
        this._cancelPendingPreview();
        if (!this._previewRec)
            return;

        this._cancelClosePreview();
        this._previewCloseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_CLOSE_MS, () => {
            this._previewCloseId = 0;
            this._destroyPreview();
            this._evaluateHover();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidePreview() {
        this._cancelPendingPreview();
        this._cancelClosePreview();
        this._destroyPreview();
    }

    _destroyPreview() {
        const rec = this._previewRec;
        this._previewRec = null;
        if (rec)
            rec.actor.destroy();
    }

    _showPreview(item, app) {
        this._hideTooltip();
        this._destroyPreview();

        let windows = app.get_windows();
        const normal = windows.filter(w => w.get_window_type() === Meta.WindowType.NORMAL);
        if (normal.length > 0)
            windows = normal;
        if (windows.length === 0)
            return;

        const box = new St.BoxLayout({
            style_class: 'macdock-preview',
            reactive: true,
            track_hover: true,
        });
        this._applyTheme(box);

        for (const win of windows.slice(0, 6))
            box.add_child(this._makePreviewItem(app, win));

        Main.uiGroup.add_child(box);

        const monitor = Main.layoutManager.primaryMonitor;
        const [ix] = item.get_transformed_position();
        const [, dockY] = this._dock.get_transformed_position();
        const [, width] = box.get_preferred_width(-1);
        const [, height] = box.get_preferred_height(width);

        let x = Math.round(ix + item.width / 2 - width / 2);
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - width - 8));
        box.set_position(x, Math.round(dockY - height - 12));

        box.connect('notify::hover', () => {
            if (box.hover)
                this._cancelClosePreview();
            else
                this._scheduleClosePreview();
            this._evaluateHover();
        });

        this._previewRec = {actor: box, app};
    }

    _makePreviewItem(app, win) {
        const button = new St.Button({
            style_class: 'macdock-preview-item',
            reactive: true,
            track_hover: true,
            can_focus: true,
        });
        button.connect('clicked', () => {
            this._hidePreview();
            Main.activateWindow(win);
        });

        const column = new St.BoxLayout({
            vertical: true,
            style_class: 'macdock-preview-col',
        });

        const title = new St.Label({
            style_class: 'macdock-preview-title',
            text: win.get_title() || app.get_name(),
            width: THUMB_W,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const thumb = new St.Widget({
            style_class: 'macdock-preview-thumb',
            width: THUMB_W,
            height: THUMB_H,
        });

        const windowActor = win.get_compositor_private();
        if (!win.minimized && windowActor) {
            const [aw, ah] = windowActor.get_size();
            const scale = Math.min(THUMB_W / aw, THUMB_H / ah, 1);
            const clone = new Clutter.Clone({source: windowActor});
            clone.set_size(Math.round(aw * scale), Math.round(ah * scale));
            clone.set_position(
                Math.round((THUMB_W - aw * scale) / 2),
                Math.round((THUMB_H - ah * scale) / 2));
            thumb.add_child(clone);
        } else {
            // minimized windows have no live picture: show the app icon
            const icon = app.create_icon_texture(48);
            icon.set_position(Math.round((THUMB_W - 48) / 2), Math.round((THUMB_H - 48) / 2));
            thumb.add_child(icon);
        }

        column.add_child(title);
        column.add_child(thumb);
        button.set_child(column);
        return button;
    }

    // ----------------------------------------------------- right-click menu

    _showMenu(button, app) {
        this._closeMenu();
        this._hideTooltip();
        this._hidePreview();
        this._resetScales();

        // Invisible anchor just above the dock; the menu opens upwards from it
        const [bx] = button.get_transformed_position();
        const [, dockY] = this._dock.get_transformed_position();
        const anchor = new St.Widget({width: 1, height: 1});
        Main.uiGroup.add_child(anchor);
        anchor.set_position(Math.round(bx + button.width / 2), Math.round(dockY - 6));

        const menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('macdock-menu');
        this._applyTheme(menu.actor);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();

        const id = app.get_id();
        const running = app.state === Shell.AppState.RUNNING;
        const pinned = this._favorites.isFavorite(id);

        if (running && app.can_open_new_window())
            menu.addAction('Open New Window', () => app.open_new_window(-1));
        else if (!running)
            menu.addAction('Open', () => app.activate());

        if (menu.numMenuItems > 0)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (pinned)
            menu.addAction('Unpin from Dash', () => this._favorites.removeFavorite(id));
        else
            menu.addAction('Pin to Dash', () => this._favorites.addFavorite(id));

        if (running) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction('Quit', () => app.request_quit());
        }

        const rec = {menu, anchor, destroyed: false};
        this._menuRec = rec;
        this._menuOpen = true;
        this._menuManager.addMenu(menu);

        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                return;
            this._menuOpen = false;
            // destroy after the close has finished
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._destroyMenu(rec);
                return GLib.SOURCE_REMOVE;
            });
            this._evaluateHover();
        });

        menu.open();
    }

    _closeMenu() {
        const rec = this._menuRec;
        if (!rec)
            return;
        try {
            rec.menu.close();
        } catch (_e) {
            // already closed
        }
        this._menuOpen = false;
        this._destroyMenu(rec);
    }

    _destroyMenu(rec) {
        if (rec.destroyed)
            return;
        rec.destroyed = true;
        if (this._menuRec === rec)
            this._menuRec = null;
        this._menuManager?.removeMenu(rec.menu);
        rec.menu.destroy();
        rec.anchor.destroy();
    }

    // ------------------------------------------------------- drag and drop

    _makeDraggable(button, item, app) {
        button._delegate = {
            app,
            getDragActor: () => app.create_icon_texture(this._iconSize),
            getDragActorSource: () => button,
        };

        const draggable = DND.makeDraggable(button, {});
        draggable.connect('drag-begin', () => {
            button.fake_release();   // let go of the button's own press grab
            this._dragging = true;
            this._hideTooltip();
            this._hidePreview();
            this._resetScales();
            item.opacity = 90;
        });
        draggable.connect('drag-end', () => {
            this._dragging = false;
            this._hideDropMarker();
            try {
                item.opacity = 255;
            } catch (_e) {
                // the item was already rebuilt
            }
            this._evaluateHover();
        });
    }

    // The app being dragged, from our own icons or from the app grid
    _dropApp(source) {
        const app = source?.app;
        return app && typeof app.get_id === 'function' ? app : null;
    }

    // Where would a drop at stage-x land among the pinned apps?
    // `gap` is the visual slot, `index` is the favorites position to use
    // (the dragged app itself is not counted).
    _computeDrop(x, excludeId = null) {
        let gap = 0;
        let index = 0;
        for (const f of this._items.filter(i => i.isFavorite)) {
            const [ix] = f.item.get_transformed_position();
            if (x <= ix + f.item.width / 2)
                break;
            gap++;
            if (f.appId !== excludeId)
                index++;
        }
        return {gap, index};
    }

    _showDropMarker(gap) {
        const favs = this._items.filter(i => i.isFavorite);
        if (!favs.length)
            return;

        if (!this._dropMarker) {
            this._dropMarker = new St.Widget({style_class: 'macdock-drop-marker'});
            // the marker can sit under the pointer: forward drops to the dock
            this._dropMarker._delegate = this._dock._delegate;
            Main.uiGroup.add_child(this._dropMarker);
        }

        const spacing = this._settings.get_int('icon-spacing');
        let x;
        let y;
        if (gap < favs.length) {
            [x, y] = favs[gap].item.get_transformed_position();
            x -= spacing / 2 + 1;
        } else {
            const last = favs[favs.length - 1].item;
            [x, y] = last.get_transformed_position();
            x += last.width + spacing / 2 - 1;
        }

        this._dropMarker.set_size(3, this._iconSize);
        this._dropMarker.set_position(Math.round(x), Math.round(y + 2));
    }

    _hideDropMarker() {
        if (this._dropMarker) {
            this._dropMarker.destroy();
            this._dropMarker = null;
        }
    }

    // ---------------------------------------------------------------- trash

    _setupTrashMonitor() {
        try {
            this._trashFile = Gio.File.new_for_uri('trash:///');
            this._trashMonitor = this._trashFile.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._connect(this._trashMonitor, 'changed', () => this._updateTrashState());
        } catch (e) {
            console.error(`${this.uuid}: cannot watch the trash: ${e.message}`);
        }
        this._updateTrashState();
    }

    _updateTrashState() {
        if (!this._trashFile)
            return;

        this._trashFile.query_info_async(
            'trash::item-count',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (file, result) => {
                try {
                    const info = file.query_info_finish(result);
                    const full = info.get_attribute_uint32('trash::item-count') > 0;
                    if (full !== this._trashFull) {
                        this._trashFull = full;
                        this._queueRebuild();
                    }
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`${this.uuid}: trash state: ${e.message}`);
                }
            });
    }

    _openTrash() {
        try {
            Gio.AppInfo.launch_default_for_uri(
                'trash:///', global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`${this.uuid}: cannot open the trash: ${e.message}`);
        }
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
