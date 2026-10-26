import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MacDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;   // keep a reference alive

        const page = new Adw.PreferencesPage({
            title: 'Mac Dock',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(page);

        const addGroup = (title, description = '') => {
            const group = new Adw.PreferencesGroup({title, description});
            page.add(group);
            return group;
        };

        const addSwitch = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const addSpin = (group, key, title, subtitle, lower, upper, step, digits = 0) => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                digits,
                adjustment: new Gtk.Adjustment({
                    lower,
                    upper,
                    step_increment: step,
                    page_increment: step * 5,
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        // Behavior
        const behavior = addGroup('Behavior');
        addSwitch(behavior, 'autohide', 'Auto-hide',
            'Slide the dock away when the pointer leaves it. Move to the bottom edge to bring it back.');
        addSwitch(behavior, 'minimize-on-click', 'Click again to minimize',
            "Click an app's icon to open it. Click again while it is in front to minimize it.");
        addSwitch(behavior, 'hover-preview', 'Window preview on hover',
            "Show thumbnails of the app's open windows when you hover its icon.");
        addSwitch(behavior, 'show-in-overview', 'Show in Activities overview',
            'Show this dock while the overview or app grid is open.');
        addSwitch(behavior, 'hide-default-dash', "Hide GNOME's default dash in the overview",
            'Stops the built-in dash from showing a second dock in the overview.');

        // Size and spacing
        const size = addGroup('Size and spacing');
        addSpin(size, 'icon-size', 'Icon size', 'In pixels', 24, 96, 2);
        addSpin(size, 'icon-spacing', 'Distance between icons', 'In pixels', 0, 40, 1);
        addSpin(size, 'dock-padding', 'Dock length padding',
            'Extra space at both ends of the dock, in pixels', 0, 60, 1);
        addSpin(size, 'bottom-margin', 'Distance from screen bottom', 'In pixels', 0, 80, 1);

        // Appearance
        const look = addGroup('Appearance');
        addSpin(look, 'corner-radius', 'Corner radius', 'In pixels', 0, 40, 1);
        addSpin(look, 'background-opacity', 'Background opacity', '0 is clear, 1 is solid',
            0, 1, 0.05, 2);
        addSwitch(look, 'show-running-indicator', 'Running app indicator',
            'Show a dot under apps that are open');
        addSwitch(look, 'show-tooltips', 'App name tooltips');

        // Magnification
        const magnify = addGroup('Magnification');
        addSwitch(magnify, 'magnification-enabled', 'Magnify icons near the pointer');
        addSpin(magnify, 'magnification-scale', 'Maximum magnification',
            '1.0 is no zoom, 2.0 is double size', 1, 2, 0.05, 2);
    }
}
