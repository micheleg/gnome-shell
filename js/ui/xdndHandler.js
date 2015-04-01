// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const DND = imports.ui.dnd;

const DRAG_STATUS_MAP = {
    0: Shell.XdndDragStatus.NO_DROP,
    1: Shell.XdndDragStatus.COPY_DROP,
    2: Shell.XdndDragStatus.MOVE_DROP,
    3: Shell.XdndDragStatus.NO_DROP
};

const XdndHandler = new Lang.Class({
    Name: 'XdndHandler',

    _init: function() {
        // Used to display a clone of the cursor window when the
        // window group is hidden (like it happens in the overview)
        this._cursorWindowClone = null;

        // Used as a drag actor in case we don't have a cursor window clone
        this._dummy = new Clutter.Actor({ width: 1, height: 1, opacity: 0 });
        Main.uiGroup.add_actor(this._dummy);
        this._dummy.hide();

        // Available mime types during XDnD.
        this.mimeTypes = Array();

        // Keeps information from xdnd-position-changed events for _onDrop and _onData.
        this._pickedActor = null;
        this._dragEvent = null;

        if (!Meta.is_wayland_compositor())
            global.init_xdnd();

        global.connect('xdnd-enter', Lang.bind(this, this._onEnter));
        global.connect('xdnd-position-changed', Lang.bind(this, this._onPositionChanged));
        global.connect('xdnd-leave', Lang.bind(this, this._onLeave));
        global.connect('xdnd-drop', Lang.bind(this, this._onDrop));
        global.connect('xdnd-data', Lang.bind(this, this._onData));

        this._windowGroupVisibilityHandlerId = 0;
    },

    // Called when the user cancels the drag (i.e release the button)
    _onLeave: function() {
        if (this._windowGroupVisibilityHandlerId != 0) {
            global.window_group.disconnect(this._windowGroupVisibilityHandlerId);
            this._windowGroupVisibilityHandlerId = 0;
        }
        if (this._cursorWindowClone) {
            this._cursorWindowClone.destroy();
            this._cursorWindowClone = null;
        }

        this.emit('drag-end');
        this.mimeTypes = Array();
    },

    _onEnter: function(obj, mimeTypes) {
        this.mimeTypes = mimeTypes;

        this._windowGroupVisibilityHandlerId  =
                global.window_group.connect('notify::visible',
                    Lang.bind(this, this._onWindowGroupVisibilityChanged));

        this.emit('drag-begin', global.get_current_time());
    },

    _onWindowGroupVisibilityChanged: function() {
        if (!global.window_group.visible) {
            if (this._cursorWindowClone)
                return;

            let windows = global.get_window_actors();
            let cursorWindow = windows[windows.length - 1];

            // FIXME: more reliable way?
            if (!cursorWindow.get_meta_window().is_override_redirect())
                return;

            let constraint_position = new Clutter.BindConstraint({ coordinate : Clutter.BindCoordinate.POSITION,
                                                                   source: cursorWindow});

            this._cursorWindowClone = new Clutter.Clone({ source: cursorWindow });
            Main.uiGroup.add_actor(this._cursorWindowClone);

            // Make sure that the clone has the same position as the source
            this._cursorWindowClone.add_constraint(constraint_position);
        } else {
            if (this._cursorWindowClone) {
                this._cursorWindowClone.destroy();
                this._cursorWindowClone = null;
            }
        }
    },

    _onPositionChanged: function(obj, x, y) {
        let pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);

        this._pickedActor = null;
        this._dragEvent = null;

        // Make sure that the cursor window is on top
        if (this._cursorWindowClone)
             this._cursorWindowClone.raise_top();

        let dragEvent = {
            x: x,
            y: y,
            dragActor: this._cursorWindowClone ? this._cursorWindowClone : this._dummy,
            source: this,
            targetActor: pickedActor
        };

        for (let i = 0; i < DND.dragMonitors.length; i++) {
            let motionFunc = DND.dragMonitors[i].dragMotion;
            if (motionFunc) {
                let result = motionFunc(dragEvent);
                if (result != DND.DragMotionResult.CONTINUE) {
                    global.set_xdnd_drag_status(DRAG_STATUS_MAP[result]);
                    return;
                }
            }
        }

        while (pickedActor) {
                if (pickedActor._delegate && pickedActor._delegate.handleDragOver) {
                    let [r, targX, targY] = pickedActor.transform_stage_point(x, y);
                    let result = pickedActor._delegate.handleDragOver(this,
                                                                      dragEvent.dragActor,
                                                                      targX,
                                                                      targY,
                                                                      global.get_current_time());

                    if (result != DND.DragMotionResult.CONTINUE) {
                        this._dragEvent = dragEvent;
                        this._pickedActor = pickedActor;
                        global.set_xdnd_drag_status(DRAG_STATUS_MAP[result]);
                        return;
                    }
                }
                pickedActor = pickedActor.get_parent();
        }

        global.set_xdnd_drag_status(DRAG_STATUS_MAP[DND.DragMotionResult.NO_DROP]);
    },

    _onDrop: function(obj) {
        let pickedActor = this._pickedActor;
        let dragEvent = this._dragEvent;

        if (pickedActor && dragEvent && pickedActor._delegate && pickedActor._delegate.acceptDrop) {
            let [r, targX, targY] = pickedActor.transform_stage_point(dragEvent.x, dragEvent.y);
            pickedActor._delegate.acceptDrop(this,
                                             dragEvent.dragActor,
                                             targX,
                                             targY,
                                             global.get_current_time());
        }

        this.emit('drag-end');
        this.mimeTypes = Array();
    },

    _onData: function(obj, mimeType, data) {
        let pickedActor = this._pickedActor;
        let dragEvent = this._dragEvent;

        if (pickedActor && dragEvent && pickedActor._delegate && pickedActor._delegate.acceptData) {
            let [r, targX, targY] = pickedActor.transform_stage_point(dragEvent.x, dragEvent.y);
            pickedActor._delegate.acceptData(this,
                                             dragEvent.dragActor,
                                             targX,
                                             targY,
                                             global.get_current_time(),
                                             mimeType,
                                             data);
        }
    },

    requestData: function(delegate, mimeType) {
        let pickedActor = this._pickedActor;

        if (pickedActor && pickedActor._delegate == delegate && 0 <= this.mimeTypes.indexOf(mimeType))
            global.request_xdnd_selection_data(mimeType);
        else
            throw new Error('Invalid XDnD data request');
    }
});

Signals.addSignalMethods(XdndHandler.prototype);
