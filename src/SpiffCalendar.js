/*
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
// ======================================================================
// Utilities.
// ======================================================================
var periods = ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY'];
var period_names = $.map(periods, function(item, index) {
    return item.toLowerCase()
          .split('_')
          .map(function(i) { return i[0].toUpperCase() + i.substring(1); })
          .join(' ');
});

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
};

function mktoday() {
    var date = new Date;
    date.setUTCHours(0,0,0,0);
    return date;
}

function isodate(date) {
    if (date == null)
        return undefined;
    if (typeof date === 'string')
        return date.replace(/-0/g, '-');
    if (typeof date === 'number')
        date = new Date(date);
    var year = date.getUTCFullYear();
    return year + '-' + (date.getUTCMonth()+1) + '-' + date.getUTCDate();
};

function to_timestamp(date) {
    if (date == null)
        return undefined;
    if (typeof date === 'number')
        return date;
    if (typeof date === 'object')
        return date.getTime();
    var dateTimeParts = date.split("T");
    var dateParts = dateTimeParts[0].split("-");
    return Date.UTC(dateParts[0], (dateParts[1] - 1), dateParts[2]);
};

function to_jsdate(date) {
    return new Date(to_timestamp(date));
};

function validator_required(input) {
    return $.trim(input.val()) !== '';
};

function get_invalid_fields(selector) {
    return selector.filter(function() {
        var validator = $(this).data('validator');
        if (!validator)
            return false;
        return !validator($(this));
    });
};

function get_invalid_field_targets(selector) {
    var invalid = get_invalid_fields(selector);
    return invalid.map(function(index, elem) {
        var target = $(elem).data('validator-target');
        return target ? target.get() : this;
    });
};

function validate_all(selector) {
    var invalid = get_invalid_fields(selector);
    invalid.addClass('error');
    return invalid.length == 0;
};

if (typeof gettext === 'undefined') {
    function gettext(str) {
        return str;
    }
}

if (typeof ngettext === 'undefined') {
    function ngettext(singular, plural, n) {
        return (n == 1 ? singular : plural).replace('%s', n);
    }
}

var _MS_PER_DAY = 1000 * 60 * 60 * 24;

// ======================================================================
// Backends
// ======================================================================
var SpiffCalendarBackend = function(options) {
    var that = this;

    this.settings = $.extend(true, {
        add_event: function(backend, event_data, success_cb) {},
        save_event: function(backend, event_data, success_cb) {},
        delete_event: function(backend, event_data, success_cb) {},
        split_event: function(backend, split_point, event_data, success_cb) {},
        save_single: function(backend, event_data, success_cb) {},
        delete_single: function(backend, event_data, success_cb) {},
        load_range: function(backend, start_date, end_date, success_cb) {}
    }, options);
    var settings = this.settings;
    var _prefetcher = null;
    var _prefetcher_xhr1 = null;
    var _prefetcher_xhr2 = null;

    // These object hold the cache. event_id_to_date is needed because
    // the cache contains only references, so when the date of an
    // event changes it would be difficult to find it in day_cache
    // for updates.
    this.event_cache = {};
    this.day_cache = {};
    this.event_id_to_date = {};

    // Rest is public API.
    this.cache_event = function(event_data) {
        that.invalidate_event(event_data);

        // Add the event to the event cache.
        var date = to_timestamp(event_data.date);
        that.event_cache[event_data.id] = event_data;
        that.event_id_to_date[event_data.id] = date;

        // Also add it to the day cache.
        var day = that.day_cache[date];
        if (typeof day === "undefined")
            day = that.day_cache[date] = {};
        if (day.events)
            day.events.push(event_data.id);
        else
            day.events = [event_data.id];
    };

    this.cache_day_data = function(date, day_data) {
        date = to_timestamp(date);
        var day = that.day_cache[date];
        if (typeof day === "undefined")
            that.day_cache[date] = day_data;
        else
            $.extend(day, day_data);
    };

    this.invalidate_event = function(event_data) {
        // Remove the old event from the event cache.
        var old_date = that.event_id_to_date[event_data.id];
        if (!old_date)
            return;
        delete that.event_cache[event_data.id];
        delete that.event_id_to_date[event_data.id];

        // Also remove it from the day cache. Since the date may have changed,
        // we need to find the day data using the formerly cached event object.
        var day = that.day_cache[old_date];
        if (!day)
            return;
        var index = day.events.indexOf(event_data.id);
        if (index != -1)
            day.events.splice(index, 1);
    };

    this.invalidate_all = function() {
        that.event_cache = {};
        that.day_cache = {};
        that.event_id_to_date = {};
    };

    this.get_event = function(event_id) {
        // Since the id is already passed, the backend should already
        // know it.
        return that.event_cache[event_id];
    };

    this.get_day_data = function(date) {
        return that.day_cache[date] || {};
    };

    this.get_range = function(start, last, success_cb) {
        if (_prefetcher)
            clearTimeout(_prefetcher);
        start = to_timestamp(start);
        last = to_timestamp(last);
        prefetcher = setTimeout(function() {
            if (_prefetcher_xhr1)
                _prefetcher_xhr1.abort();
            if (_prefetcher_xhr2)
                _prefetcher_xhr2.abort();
            _prefetcher_xhr1 = that.prefetch(last, last + 42*_MS_PER_DAY);
            _prefetcher_xhr2 = that.prefetch(start - 42*_MS_PER_DAY, start);
        }, 200);

        while (start <= last) {
            if (!that.day_cache.hasOwnProperty(start))
                return settings.load_range(that, start, last, success_cb);
            start += _MS_PER_DAY;
        }
        // Great, everything was already in the cache.
        success_cb();
    };

    this.prefetch = function(start, last) {
        while (start <= last) {
            if (!that.day_cache.hasOwnProperty(start))
                return settings.load_range(that, start, last, function() {});
            start += _MS_PER_DAY;
        }
    };

    this.add_event = settings.add_event;
    this.save_event = settings.save_event;
    this.delete_event = settings.delete_event;
    this.split_event = settings.split_event;
    this.save_single = settings.save_single;
    this.delete_single = settings.delete_single;
    this.load_range = settings.load_range;
};

// ======================================================================
// Calendar
// ======================================================================
var SpiffCalendar = function(div, options) {
    this._div = div;
    var that = this;

    this.settings = $.extend(true, {
        href: undefined,
        period: 'month',
        region: 'en',
        start: undefined,
        last: undefined,
        backend: new SpiffCalendarBackend(),
        event_renderer: undefined,
        footnote_renderer: function(e) { return e; },
        on_move_event: function(event_data, target_date) {
            event_data.date = target_date;
            settings.backend.save_single(settings.backend,
                                         event_data,
                                         that.refresh);
        },
        on_refresh: function() {}
    }, options);

    if (this._div.length != 1)
        throw new Error('selector needs to match exactly one element');
    this._div.addClass('SpiffCalendar');
    this._div.data('SpiffCalendar', this);

    this._div.append('\
        <div id="navbar">\
            <div class="nav-buttons">\
                <a id="previous" class="material" value="&lt;">\
                    <i class="material-icons">navigate_before</i>\
                </a>\
                <a id="current" class="material" value="&bull;">\
                    <i class="material-icons">today</i>\
                </a>\
                <a id="next" class="material" value="&gt;">\
                    <i class="material-icons">navigate_next</i>\
                </a>\
                <h2 id="month"></h2>\
            </div>\
            <div class="range-buttons">\
                <a class="material" value="Week" data-target="7">\
                    <i class="material-icons">view_week</i>\
                </a>\
                <a class="material" value="2 Weeks" data-target="14">\
                    <i class="material-icons">view_module</i>\
                </a>\
                <a class="material" value="Month" data-target="month">\
                    <i class="material-icons">view_comfy</i>\
                </a>\
            </div>\
        </div>\
        <table>\
            <tr>\
            </tr>\
        </table>');

    // A couple of variables that we cache for convenience and speed.
    var table = that._div.children('table');
    var settings = this.settings;
    var backend = settings.backend;
    var render_event = settings.event_renderer.render;
    var get_range_xhr = null;
    this.regional = $.datepicker.regional[settings.region];
    weekdays = this.regional.dayNames;
    months = this.regional.monthNames;

    // Temporarily add an event to find its height, to cache that as well.
    var event_div = document.createElement('div');
    event_div.className = "event";
    event_div.style.position = "absolute";
    event_div.style.visibility = "hidden";
    this._div[0].appendChild(event_div);
    var event_height = event_div.offsetHeight;
    this._div[0].removeChild(event_div);

    this._calendar_event = function(event_data) {
        var html = render_event(that._div, event_data);
        html.data('event', event_data);
        return html;
    };

    this.add_event = function(event_data) {
        var date = to_timestamp(event_data.date);
        var day = that._div.find('.day:not(.placeholder)').filter(function() {
            return this.date == date;
        });
        var events = day.find('#events');
        var theevent = that._calendar_event(event_data);
        events.append(theevent);
        return theevent;
    };

    this.remove_event = function(event_data) {
        that._div.find('.event').filter(function() {
            return event_data == $(this).data('event');
        }).remove();
    };

    this._calendar_day = function() {
        var html = $('\
            <td class="day"><div class="wrapper"><div id="day_number"></div>\
                    <div id="events"></div>\
                    <div id="footnote"></div>\
                    <div id="ellipsis"></div>\
                </div>\
            </td>');
        html.droppable({
            accept: function(d) {
                return d.closest('.event').length > 0 && !d.closest('.day').is(this);
            },
            over: function(event, ui) {
                $(this).addClass('draghover');
            },
            out: function(event, ui) {
                $(this).removeClass('draghover');
            },
            drop: function(event, ui) {
                $(this).removeClass('draghover');
                var event_data = ui.draggable.data('event');
                ui.draggable.remove();
                settings.on_move_event(event_data, this.date);
            }
        });

        return html;
    };

    this._calendar_week = function() {
        var html = $('<tr class="week"></tr>');
        for (var f = 0; f<7; f++)
            html.append(that._calendar_day());
        return html;
    };

    this.set_period = function(period) {
        if (period == "month")
            settings.period = period;
        else
            settings.period = parseInt(period);
    };

    this.set_range = function(start, last) {
        var today = mktoday();
        // Defines the days that the user wants to see. The actual visible
        // range may differ: This range may later be expanded to begin at the
        // a Sunday, for example.
        if (typeof start === "undefined") {
            var timestamp = Date.UTC(today.getUTCFullYear(),
                                     today.getUTCMonth(),
                                     today.getUTCDate() - today.getUTCDay());
            start = new Date(timestamp); // start of week
        }
        if (settings.period == "month") {
            var timestamp = Date.UTC(start.getUTCFullYear(),
                                     start.getUTCMonth(),
                                     1);
            settings.start = new Date(timestamp); // start of month
        }
        else if (settings.period%7 == 0) {
            var timestamp = Date.UTC(start.getUTCFullYear(),
                                     start.getUTCMonth(),
                                     start.getUTCDate() - start.getUTCDay());
            settings.start = new Date(timestamp); // start of week
        }
        else
            settings.start = start;
        if (typeof last !== "undefined" && last >= settings.start) {
            settings.last = last;
            return;
        }
        if (settings.period == "month") {
            var timestamp = Date.UTC(settings.start.getUTCFullYear(),
                                     settings.start.getUTCMonth() + 1,
                                     0);
            settings.last = new Date(timestamp); // end of month
        }
        else {
            var timestamp = Date.UTC(settings.start.getUTCFullYear(),
                                     settings.start.getUTCMonth(),
                                     settings.start.getUTCDate() + settings.period - 1);
            settings.last = new Date(timestamp); // end of period
        }
    };

    this._get_visible_range = function() {
        // Visible range always starts on a Sunday.
        var thestart = settings.start.getTime() - settings.start.getUTCDay()*_MS_PER_DAY;
        var thelast = settings.last.getTime() + (6 - settings.last.getUTCDay())*_MS_PER_DAY;
        return {start: thestart, last: thelast};
    };

    this.href = function(href, refresh) {
        if (!href)
            return settings.period + '/' + isodate(settings.start);
        href = href.split('/');
        that.set_period(href[0]);
        if (href.length > 1)
            var start = to_jsdate(href[1]);
        that.set_range(start);
        if (refresh == null || refresh)
            that.refresh();
    };

    this._hide_unneeded_cells = function() {
        var tr_list = table[0].children[0].children;
        var range = that._get_visible_range();
        var n_weeks = Math.ceil((range.last - range.start) / _MS_PER_DAY / 7);
        for (i = 0; i<7; i++) {
            var row = tr_list[i+1]; //skip header
            if (row)
                row.style.display = (i<n_weeks) ? 'flex' : 'none';
        }
    };

    this.refresh = function() {
        // Stop the last update if it is still ongoing.
        if (get_range_xhr)
            get_range_xhr.abort();

        var today_timestamp = mktoday().getTime();
        var range = that._get_visible_range();
        var start = range.start;
        var last = range.last;
        var setstart = settings.start;
        var setlast = settings.last;

        // Update navbar text.
        var month_name = months[setstart.getMonth()];
        var year = setstart.getFullYear();
        that._div.find("#month").text(month_name + " " + year);

        // There may be extra rows that do not need to be visible in this
        // month. We need to do this before updating each day, because it
        // changes the height of the table cells, which needs to be known
        // to show the ellipsis below.
        var n_weeks = Math.ceil((last - start) / _MS_PER_DAY / 7);
        for (i = 0; i<7; i++) {
            var row = tr_list[i+1]; //skip header
            if (row)
                row.style.display = (i<n_weeks) ? 'flex' : 'none';
        }

        // Update events.
        get_range_xhr = backend.get_range(start, last, function() {
            settings.on_refresh(that);

            // Now update each day.
            var current = start;
            var date = new Date(current);
            var last_row_number = 0;
            var placeholder_offset = 0;
            while (current <= last) {
                // Reset the offset counter on each new row.
                date.setTime(current);
                var days_since_start = Math.floor((current - start) / _MS_PER_DAY);
                var row_number = Math.floor(days_since_start / 7);
                if (row_number != last_row_number) {
                    placeholder_offset = 0;
                    last_row_number = row_number;
                }

                // Find the existing day div.
                var col_number = days_since_start - (row_number * 7);
                var row = tr_list[row_number+1];
                var day_div_obj = row.children[col_number+placeholder_offset];

                // Skip placeholders.
                var clsname = day_div_obj.className;
                if (clsname.indexOf('placeholder')!==-1) {
                    placeholder_offset++;
                    continue;
                }

                // Style the day.
                clsname = clsname.replace('filler', '').replace('today', '');
                if (date < setstart || date > setlast)
                    clsname += " filler";
                if (current == today_timestamp)
                    clsname += " today";
                day_div_obj.className = clsname;

                // Update the day number.
                var day_no = date.getDate();
                day_div_obj.date = current;
                var wrapper = day_div_obj.firstChild;
                wrapper.firstChild.textContent = day_no;

                // Update the footnote.
                var day_data = backend.get_day_data(current);
                var footnote = settings.footnote_renderer(day_data.footnote);
                wrapper.children[2].textContent = footnote;

                // Remove all events of that day.
                var events_obj = wrapper.children[1];
                while (events_obj.firstChild)
                    events_obj.removeChild(events_obj.firstChild);
                var events = $(events_obj);

                // Bail out if we don't have any events.
                current += _MS_PER_DAY;
                var event_ids = day_data.events;
                if (!event_ids)
                    continue;
                for (var i = 0, l = event_ids.length; i < l; i++) {
                    var event_data = settings.backend.get_event(event_ids[i]);
                    var event_div = that._calendar_event(event_data);
                    events.append(event_div);
                }

                // Show ellipsis if needed.
                var more = Math.ceil((event_height*l - box_height) / event_height);
                var ellipsis_obj = day_div_obj.querySelector('#ellipsis');
                if (more > 0) {
                    ellipsis_obj.className = 'visible';
                    var fmt = ngettext('%s more', '%s more', more);
                    ellipsis_obj.textContent = interpolate(fmt, [more]);
                }
                else
                    ellipsis_obj.className = '';
            }
        });
    };

    this.get_active_date = function() {
        return to_jsdate(that._div.find('.active')[0].date);
    };

    this.previous = function() {
        if (settings.period == 'month') {
            var timestamp = Date.UTC(settings.start.getUTCFullYear(),
                                     settings.start.getUTCMonth()-1,
                                     1);
            var start = new Date(timestamp);
        }
        else {
            var timestamp = Date.UTC(settings.start.getUTCFullYear(),
                                     settings.start.getUTCMonth(),
                                     settings.start.getUTCDate() - settings.period);
            var start = new Date(timestamp);
        }
        that.set_range(start, undefined);
        that.refresh();
    };

    this.to_today = function() {
        that.set_range(undefined, undefined);
        that.refresh();
    };

    this.next = function() {
        if (settings.period == 'month') {
            var timestamp = Date.UTC(settings.start.getUTCFullYear(),
                                     settings.start.getUTCMonth()+1,
                                     1);
            var start = new Date(timestamp);
        }
        else {
            var timestamp = Date.UTC(settings.start.getUTCFullYear(),
                                     settings.start.getUTCMonth(),
                                     settings.start.getUTCDate() + settings.period);
            var start = new Date(timestamp);
        }
        that.set_range(start, undefined);
        that.refresh();
    };

    // Add calendar table header and cells.
    $.each(this.regional.dayNamesMin, function(i, val) {
        table.find("tr").append("<th>" + val + "</th>");
    });
    for (var i=0; i<7; i++)
        table.children().append(that._calendar_week());
    var tr_list = table[0].children[0].children;

    // Connect navbar button events.
    this._div.find("#previous").click(this.previous);
    this._div.find("#current").click(this.to_today);
    this._div.find("#next").click(this.next);
    this._div.find(".range-buttons a").click(function() {
        that.set_period($(this).data('target'));
        that.set_range(settings.start);
        that.refresh();
    });

    // Unzoom the day when clicking outside of it.
    $('body').mousedown(function(e) {
        if ($(e.target).closest('.SpiffCalendarDialog').length
                || $(e.target).closest('.ui-datepicker').length)
            return;
        var day = $(e.target).closest('.day');
        if (day.is('.day.active'))
            return;
        var day = table.find('.day.active');
        day.velocity({
            top: day.data('original_top'),
            left: day.data('original_left'),
            width: day.data('original_width'),
            height: day.data('original_height')
        }, 100, function() {
            day.removeClass('active active-done').css({
                top: 0,
                left: 0,
                width: 'auto',
                height: 'auto'
            });
            day.data('placeholder').remove();
        });
    });

    // Fold event when clicking outside of it.
    $('body').click(function(e) {
        if ($(e.target).closest('.ui-datepicker').length
            || $(e.target).closest('.ui-dialog').length
            || $(e.target).closest('.placeholder').length)
            return;

        // Did the user click into empty space on the day?
        var day = $(e.target).closest('.day');
        var theevent = $(e.target).closest('.event');
        var empty_day_clicked = !theevent.length && day.length;

        // Then the user just opened a new event. Find it.
        if (empty_day_clicked)
            theevent = day.find('.unfolded').filter(function() {
               return !$(this).data('event').id;
            });

        // Fold all events, except the clicked or opened one.
        var unfolded = table.find('.unfolded').not(theevent);

        // Remove all unsaved events, except the clicked or opened one.
        unfolded.each(function() {
            var ev = $(this);
            ev.removeClass('unfolded').draggable('enable');
            var ev_data = ev.data('event');
            if (ev_data && !ev_data.id)
                ev.remove();
        });
    });

    table.click(function(e) {
        var day = $(e.target).closest('.day');
        if (!day.is('.day') || day.hasClass('placeholder'))
            return;

        var theevent = $(e.target).closest('.event');
        if (theevent.length > 0) {
            // Unfold the clicked event.
            if (!theevent.hasClass('unfolded')) {
                theevent.addClass('unfolded');
                theevent.draggable('disable');
                theevent.find('input:first').focus();
            }
        }
        else {
            // Create a new event if needed.
            var new_editor = $(e.target).find('.unfolded').filter(function() {
                return typeof $(this).data('event').id === 'undefined';
            });
            if (!new_editor.length) {
                var date = new Date(day[0].date);
                theevent = that.add_event({date: date});
                theevent.children().click(); // trigger rendering/unfold/focus
            }
        }

        if (day.hasClass('active'))
            return;

        // Create an exact clone of the day as a placeholder. The reason
        // that we don't use the clone as the editor is that a) there may be
        // events running on the original day, and b) we would have to
        // either use clone(true), causing problems with per-event
        // data not being copied, or re-init/re-draw the day from scratch,
        // causing potential flickering and other headaches.
        var placeholder = day.clone();
        placeholder.css('visibility', 'hidden');
        placeholder.addClass('placeholder');
        placeholder.find('.event').removeClass('unfolded');

        var w = day.width()
        var h = day.height()
        day.data('placeholder', placeholder);
        day.data('original_top', day.offset().top);
        day.data('original_left', day.offset().left);
        day.data('original_width', w);
        day.data('original_height', h);
        day.css({
            top: day.offset().top,
            left: day.offset().left,
            width: w,
            height: h
        });
        day.addClass('active');
        theevent.children(":first").click(); // Unfold the clicked event.

        placeholder.insertBefore(day);

        // Resize the day.
        var top = day.offset().top - h/1.3;
        var left = day.offset().left - w/2;
        h = 2.5*h;
        w = 2*w;

        if (top < 0)
            top = 20;
        if (top + h > $(window).height())
            top -= h/3;
        if (top < 0) {
            top = 20;
            h = $(window).height() - 40;
        }

        if (left < 0)
            left = 20;
        if (left + w > $(window).width())
            left -= w/4;
        if (left < 0) {
            left = 20;
            w = $(window).width() - 40;
        }

        day.velocity({
            top: top,
            left: left,
            width: w,
            height: h
        }, 200, function() { day.addClass('active-done'); });
    });

    this._div.children().bind('wheel mousewheel DOMMouseScroll', function (event) {
        if (that._div.find('.active').length)
            return;
        if (event.originalEvent.wheelDelta > 0 || event.originalEvent.detail < 0)
            that.next();
        else
            that.previous();
    });

    if (settings.href)
        this.href(settings.href, false);
    else
        this.set_range(settings.start, settings.last);

    // Calculate the box size only once, becaus clentHeight causes a reflow.
    that._hide_unneeded_cells();
    var box_obj = table.find('tr:nth-child(2) .day:first #events')[0];
    var box_height;

    // A changed row height may mean we need to update the ellipsis that is
    // shown when there are too many events.
    $(window).resize(function() {
        box_height = box_obj.clientHeight;
        that.refresh();
    });
    $(window).resize();
};

// ======================================================================
// Renderer for events, for both inline edit-mode and inline view-mode.
// ======================================================================
var SpiffCalendarEventRenderer = function(options) {
    var that = this;
    var settings = $.extend(true, {
        event_dialog: new SpiffCalendarEventDialog(),
        render_extra_content: function() {},
        serialize_extra_content: function() {},
        deserialize_extra_content: function() {},
        on_render: function(calendar, html, event_data) {},
        on_save_before: function(calendar, html) {
            if (!validate_all(html.find('input')))
                return false;
        },
        on_save: function(calendar, html, event_data) {
            var backend = calendar.settings.backend;
            var func = event_data.id ? backend.save_single : backend.add_event;
            func(backend, event_data, calendar.refresh);
        },
        on_edit_before: function(calendar, html) {},
        on_edit: function(calendar, html, event_data) {
            settings.event_dialog.show(calendar, event_data);
        },
        on_delete_before: function(calendar, event_data) {},
        on_delete: function(calendar, html, event_data) {
            var backend = calendar.settings.backend;
            backend.delete_single(backend, event_data, calendar.refresh);
        }
    }, options);

    this.on_event_clicked = function() {
        if (this.initialized)
            return;
        this.initialized = true;

        // Initializing the datepicker is extremely slow. By deferring the
        // initialization until the event is clicked, the refresh time for a
        // single page was reduced by 200ms.
        html = $(this);
        var datepicker = html.find('.general-date');
        if (datepicker.is('.hasDatepicker'))
            return;
        var event_data = html.data('event');
        datepicker.datepicker({
            beforeShow: function() {
                 $(this).datepicker('widget').addClass('material');
            },
            onSelect: function() {
                this.blur();
                $(this).change();
            }
        }).datepicker("setDate", to_jsdate(event_data.date));

        // Some other things that also benefit from being deferred until
        // clicked.
        html.find('.general-name').val(event_data.name);

        // Connect event handlers for input validation.
        var save_btn = html.find('#button-save');
        var inputs = html.find('#general').children();
        inputs.keydown(function(e) {
            $(this).removeClass('error');
            if (e.keyCode === 13)
                save_btn.click();
        });
        inputs.bind('keyup change select', function(e) {
            var nothidden = inputs.filter(":not([style$='display: none;'])");
            var invalid = get_invalid_fields(nothidden);
            save_btn.prop("disabled", invalid.length != 0);
        });

        // Connect button event handlers.
        save_btn.click(function(event) {
            var editor = $(this).closest('.editor').parent();
            var calendar = editor.closest('.SpiffCalendar').data('SpiffCalendar');
            if (settings.on_save_before(calendar, editor) == false)
                return;
            that._serialize(editor, event_data, true);
            if (settings.on_save(calendar, editor, event_data) != false)
                editor.removeClass('unfolded');
            event.stopPropagation(); // prevent from re-opening
        });
        html.find('#button-edit').click(function(event) {
            var editor = $(this).closest('.editor').parent();
            var calendar = editor.closest('.SpiffCalendar').data('SpiffCalendar');
            if (settings.on_edit_before(calendar, editor) == false)
                return;
            that._serialize(editor, event_data, false);
            if (settings.on_edit(calendar, editor, event_data) != false)
                editor.removeClass('unfolded');
        });
        html.find('#button-delete').click(function(event) {
            var editor = $(this).closest('.editor').parent();
            var calendar = editor.closest('.SpiffCalendar').data('SpiffCalendar');
            that._serialize(editor, event_data, false);
            if (settings.on_delete(calendar, editor, event_data) != false)
                editor.removeClass('unfolded');
            event.stopPropagation(); // prevent from re-opening
        });

        // Trigger validation.
        inputs.keyup();

        // Extra content may be provided by the user.
        // If the user provided settings.render_extra_content, he may
        // also want to populate it with data.
        var extra = html.find('#extra-content');
        settings.render_extra_content(extra, event_data);
        settings.deserialize_extra_content(extra, event_data);
    }

    var prerendered = $('\
            <div class="event">\
                <div class="label">\
                    <span id="label-left"></span>\
                    <span id="label-icon"></span>\
                    <span id="label-prefix"></span>\
                    <span id="label-name"></span>\
                    <span id="label-suffix"></span>\
                    <span id="label-right"></span>\
                </div>\
                <div class="editor">\
                    <div id="general">\
                        <input class="general-name material"\
                            type="text"\
                            placeholder="'+gettext("Event")+'"\
                            required/>\
                        <input class="general-date material"\
                            type="text"\
                            placeholder="'+gettext("Date")+'"\
                            required/>\
                    </div>\
                    <div id="extra-content"></div>\
                    <div id="event-buttons">\
                        <button id="button-delete" class="material link small">\
                            <i class="material-icons">delete</i>\
                        </a>\
                        <button id="button-edit" class="material small">\
                            <i class="material-icons">repeat</i>\
                        </a>\
                        <button id="button-save" class="material small">\
                            <i class="material-icons">done</i>\
                        </a>\
                    </div>\
                </div>\
            </div>');

    var draggable_options = {
        helper: function(e, ui) {
            var original = $(e.target).closest(".ui-draggable");
            return $(this).clone().css({width: original.width()});
        },
        revert: "invalid",
        cursor: "move",
        revertDuration: 100,
        start: function () {
            $(this).hide();
        },
        stop: function () {
            $(this).show();
        }
    };

    function on_event_hover() {
        $(this).draggable(draggable_options);
        $(this).click(that.on_event_clicked);
        $(this).find('.general input').data('validator', validator_required);
    };

    this.render = function(calendar_div, event_data) {
        html = prerendered.clone();
        var html_obj = html[0];
        if (event_data.time)
            html_obj.className += ' timed';
        if (event_data.freq_type != null && event_data.freq_type !== 'ONE_TIME')
            html_obj.className += ' recurring';
        if (event_data.is_exception)
            html_obj.className += ' exception';

        // These fields are only shown on new events.
        if (!event_data.id) {
            html.find('.general-date').hide();
            html.find('#button-delete').hide();
        }

        // Add data to the UI.
        if (event_data.time)
            html_obj.querySelector('#label-prefix').textContent = event_data.time;
        html_obj.querySelector('#label-name').textContent = event_data.name;
        settings.on_render(html, event_data);

        // jQuery's draggable() function is very slow. So we don't call it until
        // the user hovers over the element. Updating the draggable options here
        // is a hack, but it's faster, so I don't care.
        draggable_options.appendTo = calendar_div;
        html.one('mouseenter click', on_event_hover);

        return html;
    };

    this._serialize = function(html, event_data, include_date) {
        var date = html.find('.general-date').datepicker('getDate');
        // jQuery's datepicker does not return the date in UTC, dammnit.
        date = to_jsdate(date - new Date(date).getTimezoneOffset() * 60000);

        if (!event_data)
            event_data = {};
        if (include_date == true)
            event_data.date = date;
        event_data.name = html.find('.general-name').val();

        // If the user provided settings.render_extra_content, he may
        // also want to serialize it.
        var extra = html.find('#extra-content');
        settings.serialize_extra_content(extra, event_data);
    };
};

// ======================================================================
// Dialog for editing event details.
// ======================================================================
var SpiffCalendarEventDialog = function(options) {
    this._div = $('<div></div>');
    var that = this;
    var settings = $.extend(true, {
        region: 'en',
        event_data: {date: mktoday()},
        render_extra_content: function(div, event_data) {},
        serialize_extra_content: function() {},
        deserialize_extra_content: function() {},
        on_save: function(calendar, event_data) {
            var backend = calendar.settings.backend;
            var func = event_data.id ? backend.save_event : backend.add_event;
            func(backend, event_data, calendar.refresh);
        },
        on_delete: function(calendar, event_data) {
            var backend = calendar.settings.backend;
            backend.delete_event(backend, event_data, calendar.refresh);
        }
    }, options);

    this.regional = $.datepicker.regional[settings.region];
    weekdays = this.regional.dayNames;

    this._recurring_range = function() {
        var html = $('\
            <div class="recurring-range">\
              <select>\
                  <option value="forever">'+gettext("forever")+'</option>\
                  <option value="until">'+gettext("until")+'</option>\
                  <option value="times">'+gettext("until counting")+'</option>\
              </select>\
              <span id="recurring-range-until">\
                  <input type="text" class="datepicker material" required/>\
              </span>\
              <span id="recurring-range-times">\
                  '+gettext('<input id="recurring-range-times-field" class="material" type="number" min="1" value="1" required/>\
                  <label>times.</label>')+'\
              </span>\
            </div>');
        html.find('input.datepicker').datepicker({
            beforeShow: function() {
                 $(this).datepicker('widget').addClass('material');
            }
        });
        html.find('input.datepicker').data('validator', validator_required);
        html.find('#recurring-range-times-field').data('validator', validator_required);
        html.find('select').change(function() {
            html.find('span').hide();
            html.find('#recurring-range-' + $(this).val()).show();
        });
        html.find('select').change();
        return html;
    };

    this._recurring_never = function() {
        var html = $('\
            <div class="recurring-never" style="display: none">\
            </div>');
        return html;
    };

    this._recurring_day = function() {
        var html = $('\
            <div class="recurring-day" style="display: none">\
              '+gettext('Repeat every\
              <input class="interval material" type="number" min="1" value="1" required/>\
              day(s)')+',\
            </div>');
        html.find('input.interval').data('validator', validator_required);
        html.append(that._recurring_range());
        return html;
    };

    this._recurring_week = function() {
        var html = $('\
            <div class="recurring-week" style="display: none">\
              '+gettext('Repeat every\
              <input class="interval material" type="number" min="1" value="1" required/>\
              week(s) on\
              <div id="weekdays"></div>')+',\
            </div>');
        html.find('input.interval').data('validator', validator_required);

        // Day selector.
        $.each(weekdays, function(i, val) {
            var day_html = $('<label><input\
                    type="checkbox" class="material" name="day"/>\
                </label>');
            day_html.find('input').data('value', Math.pow(2, (i == 0) ? 6 : (i-1)));
            day_html.append(val);
            html.find('#weekdays').append(day_html);
        });
        html.find('input').data('validator-target', html.find('#weekdays'));
        html.find('input').data('validator', function() {
            return html.find('input:checked').length > 0;
        });

        html.append(that._recurring_range());
        return html;
    };

    this._recurring_month = function() {
        var html = $('\
            <div class="recurring-month" style="display: none">\
              '+gettext('Repeat every\
              <input class="interval material" type="number" min="1" value="1" required/>\
              month(s), on\
              <span id="recurring-month-byday">\
              the\
                  <select id="recurring-month-count">\
                        <option value="1">first</option>\
                        <option value="2">second</option>\
                        <option value="4">third</option>\
                        <option value="8">fourth</option>\
                        <option value="-1">last</option>\
                        <option value="-2">second-last</option>\
                        <option value="-4">third-last</option>\
                        <option value="-8">fourth-last</option>\
                  </select>\
              </span>')+'\
              <select id="recurring-month-weekday">\
                  <option value="0">day</option>\
              </select>\
              <input id="recurring-month-dom"\
                     class="material"\
                     type="number"\
                     min="1"\
                     max="31"\
                     required/>,\
            </div>');
        html.find('#recurring-month-dom').hide();
        html.find('input.interval').data('validator', validator_required);

        // Day selector.
        $.each(weekdays, function(i, val) {
            var day_html = $('<option/>');
            day_html.val(Math.pow(2, (i == 0) ? 6 : (i-1)));
            day_html.append(val);
            html.find('#recurring-month-weekday').append(day_html);
        });

        html.find('#recurring-month-weekday').change(function() {
            if ($(this).val() == 0) {
                html.find('#recurring-month-byday').hide();
                html.find('#recurring-month-dom').show();
            }
            else {
                html.find('#recurring-month-dom').hide();
                html.find('#recurring-month-byday').show();
            }
        });

        html.append(that._recurring_range());
        return html;
    };

    this._recurring_year = function() {
        var html = $('\
             <div class="recurring-year" style="display: none">\
               '+gettext('Repeat every\
               <input class="interval material" type="number" min="1" value="1" required/>\
               year(s)')+',\
            </div>');
        html.find('input.interval').data('validator', validator_required);
        html.append(that._recurring_range());
        return html;
    };

    this._get_section_from_freq_type = function(freq_type) {
        if (freq_type === 'ONE_TIME')
            return that._div.find('.recurring-never');
        else if (freq_type === 'DAILY')
            return that._div.find('.recurring-day');
        else if (freq_type === 'WEEKLY')
            return that._div.find('.recurring-week');
        else if (freq_type === 'MONTHLY')
            return that._div.find('.recurring-month');
        else if (freq_type === 'ANNUALLY')
            return that._div.find('.recurring-year');
        console.error('invalid freq_type', freq_type);
    };

    this._period_changed = function() {
        var input = $(this);
        that._div.find('#recurring-period button').removeClass('active');
        input.addClass('active');
        var freq_type = input.val();
        that._div.find('#recurring-detail>div').hide();
        var section = that._get_section_from_freq_type(freq_type);
        section.show();
    };

    this._init = function() {
        that._div.append('\
            <div>\
                <div class="general">\
                    <input id="general-name"\
                        class="material"\
                        type="text"\
                        placeholder="'+gettext("Name")+'"\
                        required/>\
                    <input id="general-date"\
                        class="material"\
                        type="text"\
                        placeholder="'+gettext("Date")+'"\
                        required/>\
                </div>\
                <div id="extra-content"></div>\
                <div id="recurring-period" class="radio-bar">\
                </div>\
                <div id="recurring-detail">\
                </div>\
                <div id="buttons">\
                    <button id="button-delete" class="material link">'+gettext("Delete")+'</button>\
                    <button id="button-save" class="material">'+gettext("Save")+'</button>\
                </div>\
            </div>');
        that._div.find('#error').hide();
        that._div.find('#general-name').data('validator', validator_required);
        that._div.find('#general-date').datepicker();
        that._div.find('#general-date').data('validator', validator_required);

        // Period selector.
        $.each(periods, function(index, item) {
            var button = $('<button name="period"></button>');
            button.val(item);
            button.append(period_names[index]);
            button.click(that._period_changed);
            that._div.find('#recurring-period').append(button);
        });

        /*/ Month selector.
        $.each(months, function(i, val) {
            var month_html = $('<label><input type="checkbox" class="material" name="month"/></label>');
            month_html.val(i+1);
            month_html.append(val);
        });
    */

        var detail = that._div.find('#recurring-detail');
        detail.append(that._recurring_never());
        detail.append(that._recurring_day());
        detail.append(that._recurring_week());
        detail.append(that._recurring_month());
        detail.append(that._recurring_year());
        detail.find("button:first").click();

        // Extra content may be provided by the user.
        settings.render_extra_content(that._div.find('#extra-content'),
                                      settings.event_data);

        // Validate fields on input.
        var save_btn = that._div.find('#button-save');
        that._div.find('input').keydown(function(e) {
            $(this).removeClass('error');
            if (e.keyCode === 13)
                save_btn.click();
        });
        that._div.find('input').change(function(e) {
            if ($(this).data('validator-target'))
                $(this).data('validator-target').removeClass('error');
            else
                $(this).removeClass('error');
        });
        that._div.find('input,select,button').bind('keyup change select click', function(e) {
            var nothidden = that._div.find("input:visible");
            var invalid = get_invalid_fields(nothidden);
            save_btn.prop("disabled", invalid.length != 0);
        });

        that._div.find('#button-save').click(function(e) {
            var nothidden = that._div.find("input:visible");
            var invalid = get_invalid_field_targets(nothidden);
            if (invalid.length != 0) {
                invalid.addClass('error');
                e.stopPropagation();
                return;
            }
            that._div.dialog('close');
            that._serialize(settings.event_data);
            var calendar = that._div.data('SpiffCalendar');
            return settings.on_save(calendar, settings.event_data);
        });
        that._div.find('#button-delete').click(function(e) {
            that._div.dialog('close');
            var calendar = that._div.data('SpiffCalendar');
            return settings.on_delete(calendar, settings.event_data);
        });
    };

    this._serialize = function(event_data) {
        // Serialize general data first.
        event_data.name = that._div.find('#general-name').val();
        var date = that._div.find('#general-date').datepicker('getDate');
        // jQuery's datepicker does not return the date in UTC, dammnit.
        event_data.date = to_jsdate(date - new Date(date).getTimezoneOffset() * 60000);

        // Serialize recurrence data.
        var selected = that._div.find('#recurring-period button.active');
        var freq_type = selected.val();
        event_data.freq_type = freq_type;

        // Much of the recurrence data depends on the currently selected
        // freq_type.
        var section = that._get_section_from_freq_type(freq_type);
        event_data.freq_interval = section.find('.interval').val();

        // Serialize freq_target.
        if (freq_type === 'WEEKLY') {
            var flags = 0;
            section.find('#weekdays input:checked').each(function() {
                flags |= $(this).data('value');
            });
            event_data.freq_target = flags;
        }
        else if (freq_type === 'MONTHLY')
            event_data.freq_target = section.find('#recurring-month-weekday').val();
        else if (freq_type === 'ANNUALLY')
            event_data.freq_target = 0; //section.find('#recurring-year-doy').val(); <- see docs in _update()
        else
            event_data.freq_target = undefined;

        // Serialize freq_count.
        if (freq_type === 'MONTHLY' && event_data.freq_target == 0)
            event_data.freq_count = section.find('#recurring-month-dom').val();
        else if (freq_type === 'MONTHLY')
            event_data.freq_count = section.find('#recurring-month-count').val();
        else
            event_data.freq_count = undefined;

        // Serialize until_count and until_date.
        var duration = section.find('.recurring-range select').val();
        var until_date = section.find('#recurring-range-until input').datepicker('getDate');
        var until_count = section.find('#recurring-range-times input').val();
        event_data.until_date = undefined;
        event_data.until_count = undefined;
        if (duration === 'until')
            event_data.until_date = until_date;
        else if (duration === 'times')
            event_data.until_count = until_count;

        // Lastly, if the user provided settings.render_extra_content, he may
        // also want to serialize it.
        var extra = that._div.find('#extra-content');
        settings.serialize_extra_content(extra, event_data);
    };

    this._update = function() {
        if (settings.event_data.name)
            that._div.find('#button-delete').show();
        else
            that._div.find('#button-delete').hide();

        // Update general event data.
        this._div.find('#general-name').val(settings.event_data.name);
        var date = to_jsdate(settings.event_data.date);
        if (!date)
            date = mktoday();
        this._div.find("#general-date").datepicker('setDate', date);

        var freq_type = settings.event_data.freq_type;
        var period_id = periods.indexOf(freq_type);
        if (period_id == -1)
            period_id = 0;
        this._div.find("button")[period_id].click();

        // Update the weekday for weekly events.
        var freq_target = settings.event_data.freq_target;
        if (freq_target == null) {
            var day_num = date.getDay();
            freq_target = Math.pow(2, (day_num == 0) ? 6 : (day_num-1));
        }
        var section = that._get_section_from_freq_type('WEEKLY');
        section.find('#weekdays input').each(function() {
            $(this).prop('checked', (freq_target&$(this).data('value')) != 0);
        });

        // Update the day of month for monthly events.
        var freq_target = settings.event_data.freq_target;
        if (freq_target == null)
            freq_target = 0;
        section = that._get_section_from_freq_type('MONTHLY');
        section.find('#recurring-month-weekday').val(freq_target);
        section.find('#recurring-month-weekday').change();
        section.find('#recurring-month-dom').val(date.getUTCDate());
        var num_days = new Date(date.getFullYear(),
                                date.getMonth() + 1,
                                0).getDate();
        section.find('#recurring-month-dom').prop('max', num_days);

        if (freq_type) {
            var section = that._get_section_from_freq_type(freq_type);

            // Update interval (=nth day/week/month/year)
            section.find('.interval').val(settings.event_data.freq_interval);

            // MONTLY is the only type where freq_count matters. It is a
            // bitmask specifiying the nth freq_target of the month. E.g.
            // 1=first target of the month, 2=second, 4=third
            // -1=last target of the month, -2=second-last, ...
            // 0=every occurence.
            if (freq_type === 'MONTHLY')
                section.find('#recurring-month-count').val(settings.event_data.freq_count);

            //We have no UI yet for specifying annual events with a fixed target
            //day. Hence for annual events, freq_target is always 0, meaning "same
            //calendar day as the initial event".
            //else if (freq_type === 'ANNUALLY')
            //    section.find('#recurring-year-doy').val(settings.event_data.freq_target);

            // Deserialize until_count and until_date.
            var input = section.find('#recurring-range-until input');
            input.datepicker('setDate', to_jsdate(settings.event_data.until_date));
            section.find('#recurring-range-times input').val(settings.event_data.until_count);
            var select = section.find('.recurring-range select');
            if (settings.event_data.until_date)
                select.find('option[value="until"]').prop('selected', true);
            else if (settings.event_data.until_count)
                select.find('option[value="times"]').prop('selected', true);
            else
                select.find('option[value="forever"]').prop('selected', true);
            select.change();
        }

        // Lastly, if the user provided settings.render_extra_content, he may
        // also want to populate it with data.
        var extra = that._div.find('#extra-content');
        settings.deserialize_extra_content(extra, settings.event_data);
    };

    this.show = function(calendar, event_data) {
        if (event_data)
            settings.event_data = $.extend(true, {}, event_data);
        that._update();
        that._div.data('SpiffCalendar', calendar);
        that._div.dialog('open');
        that._div.addClass('opening');
        that._div.find('input').change(); // Trigger validation.
    };

    this.hide = function() {
        this._div.dialog('close');
    };

    that._div.dialog({
        autoOpen: false,
        title: gettext("Repeating Events"),
        dialogClass: 'SpiffCalendarDialog material',
        width: $('body').width()*.7,
        minWidth: 650,
    });

    $('body').click(function(e) {
        if (!that._div.dialog('instance'))
            return;
        if ($(e.target).closest('.SpiffCalendarDialog').length)
            return;
        if (!that._div.hasClass('opening'))
            that._div.dialog('close');
        that._div.removeClass('opening');
    });

    this._init();
    this._update();
};
