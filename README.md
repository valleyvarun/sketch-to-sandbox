# sketch-to-sandbox

Open the site through a local HTTP server (for example, VS Code Live Server),
not a `file://` URL, so Mapbox can load the GeoJSON from `datasets/`.
Enter a Mapbox public token in the page prompt. If URL-restricted, the token
must allow the server address.

The light basemap displays the Bengaluru metro and suburban rail GeoJSON
using each line's `stroke` color and dark-blue station dots with white outlines.
Suburban routes are dashed; metro routes remain solid.
The map and routing use `datasets/Bengaluru_metro_suburban_rail_upgraded.geojson`.
Its station and line history metadata drives the opening-year view.

## Map year

The bottom-center arrows step through 2010-2026, then **final plan** (the
default). Each numbered year includes recorded passenger-service openings
through the end of that year, not planned opening dates. Final plan includes
all geometry, including proposals and sections with unknown opening dates.
The square play/pause button below the selector starts at 2010, displays each
year and final plan for one second, and loops. Pause holds the current view;
playing again restarts at 2010. Using either year arrow stops autoplay.

Lines are split at their existing station vertices. A segment becomes visible
when both endpoints are open on that specific line, so an earlier interchange
opening on another line cannot reveal a future line. Transfer links require
both endpoint stations to be open; the dataset does not establish separate
transfer opening dates. Undated stations and lines appear only in final plan.

Year changes clear the highlighted trip, popup, and picking mode. Search,
station labels, map picking, and Travel routing use the selected year's
network. Existing From/To choices are retained only if open that year. Footer
checkbox settings are preserved.

The footer checkboxes default to checked. Network controls toggle their routes,
station dots, and labels; transfer links appear only when both networks are on.
The station names control toggles black labels for the visible networks.

Click a visible station dot to open a speech-bubble table with its name,
coordinates (latitude, longitude), opening date, and opening year.
These are the earliest recorded passenger-service opening fields, not
construction-completion dates. Missing dates and years display "-" and
source date conflicts are flagged. Clicking elsewhere or hiding the station's
network dismisses the popup. Map-pick mode selects a travel endpoint instead.

## Travel

The left sidebar contains Travel and Construction Plan modes.
Choose two different stations using the searchable inputs or the adjacent
map-pick buttons, then press **Travel**. Search suggestions use the `name` property
of station points only, not route names. IDs are shown only for duplicate station
names; select a specific suggestion when a name occurs more than once.
The custom dropdown stays open while typing or deleting, and closes when a
station is selected with a click or Enter.
No matches displays a message rather than closing the list. Click outside,
press Escape, or Tab away to dismiss it. Arrow keys and Enter select a result.
Map picking uses visible station dots; press Escape or the active pick button
to cancel.

Routing first minimizes line changes, then chooses the shortest distance among
routes with that minimum number of changes. Distance includes the supplied rail
geometries and explicit walking connections; there is no fixed distance penalty
that could trade an extra line change for a shorter trip. Boarding the first
line does not count as a change. Walking connections preserve the last boarded
line, and subsequently boarding a different route ID counts as one change.
The result displays both line changes and distance.
Shared station IDs permit changes between lines;
crossing lines alone do not create connections. Highlighted segments follow
the original line coordinates and colors. Other network lines become thin and
black, labels show only route stations, and rectangles mark Start and End.
Editing either input clears the result. Travel enables labels and any hidden
networks needed by the route; footer controls can still hide them afterwards.
The trash-can button beside Travel clears both station fields and the result,
cancels map picking, and restores normal network styling without changing
the footer visibility settings.

### Travel details and estimates

Travel status and results appear in the right sidebar, not the left form.
Results include distance (including walks), estimated minutes, distinct stations
including endpoints, lines in travel order, line changes, and estimated total
cost with separate Metro/suburban amounts. Each rail leg is drawn vertically
with endpoint circles, its boarding/alighting station names, and a thick line
in its original color (solid Metro, dashed suburban). Intermediate station
names are omitted. Successful results start with the details table rather
than a duplicate summary paragraph; loading, selection and error messages
still appear when relevant. The bottom of that panel shows the
total distance, time and cost formulas with full-word subscripts, numeric
constant tables, fare slabs and a source link. Routing priority is stated in
one sentence; detailed component formulas and variable definitions are omitted.
Construction mode shows the
saved phase list instead, without deleting it when switching back to Travel.
Changing stations or year, clearing Travel, or entering construction clears
the old Travel result.

Drag the right sidebar's left divider to resize it. Its minimum width is 300px;
the maximum leaves 200px for the map when the viewport permits. The divider
also supports keyboard Left/Right arrows (20px steps), Home (minimum) and End
(maximum). Both sidebar modes use the chosen width for this page session, and
the map resizes with the panel.

Time uses explicit planning assumptions: Metro running speed 40 km/h, suburban
50 km/h, walking 4.5 km/h; intermediate same-line stops of 30 and 60 seconds,
respectively. Same-system transfers add 5 minutes; Metro/suburban transfers
add 12 minutes. Mapped walking time is additional. Transfers replace a station
stop, and reboarding after a walking link also incurs a transfer allowance.
Initial waiting and service delays are not modeled. These are assumptions,
not verified operating speeds or timetable predictions.

Metro token fares use the **dated official slabs effective 9 February 2025**:
up to 2/4/6/8/10/15/20/25/30 km costs INR
10/20/30/40/50/60/70/80/90; over 30 km remains INR 90.
[BMRCL's official notice dated 8 February 2025](https://english.bmrc.co.in:8282/English/uploads/news/english/fileuploads/1739069224825$@!!Media%20Brief%20-English-%20Fin%2008.02.2025%20(1).pdf)
was verified, but its continued applicability in October 2026 could not be
confirmed. The user approved this dated baseline with a visible warning.
Slabs use unrounded mapped distance, not the official station-pair fare matrix,
so prices are estimates, especially for proposed routes. These same rates
apply in all map years; they are not historical fares. Token pricing excludes
smart-card discounts, concessions and passes.

Suburban pricing is explicitly hypothetical: max(INR 10, rounded-up distance
in km x INR 2). Each uninterrupted paid-system journey is charged separately.
Changing Metro lines within the paid area does not start another fare; a
walking link or system change is assumed to require exit/re-entry and a new
fare. Walking itself is free. No current official suburban tariff is claimed.

## Construction Plan

Click **Add Phase** or **Edit construction plan** to enter construction mode.
Travel inputs, picks, and the route are cleared and disabled; autoplay stops,
and the map locks to final plan. Recorded passenger-service openings through
2026 are used as the proxy for already-constructed stations and segments.
These line segments keep their original colors, and opened stations use black
circles, including when another line is focused or the section belongs to a
highlighted phase. Unknown openings are not assumed built.
Opened rail sections are thicker in construction mode: 6px for metro and
3px for suburban rail, even when another line is focused. Their original colors
and suburban dash patterns are preserved.

The first phase defaults to number 3; numbers can be edited and must be unique,
positive whole numbers. Subsequent phases default to the next number. Choose
the first station, then the second on the same line. Both searches show
only stations that have not opened yet. Saved phase endpoints are available in
both fields; saved interior stations are excluded. After choosing the first
station and line, the second search removes choices whose path overlaps a saved
phase. Phases may meet at shared endpoints, including interchanges, but cannot
reuse interior stations or track segments, even in reverse. These rules apply
regardless of phase numbers. A line selector appears
only if the first station is an interchange. Changing the first station or line
clears the second station. Each station field also has a map-pick button, with
the same eligibility rules as its dropdown. The second button is enabled after
choosing a first station and line. Invalid map picks show a notice and keep
picking active; Escape or clicking the same button cancels. Editing, clearing,
building, or switching modes also cancels picking.
Unopened line sections outside a phase use darker shades of their original colors
(half of each RGB channel), rather than turning other lines black. Unopened
sections assigned to a draft or saved phase keep their original colors, even
when another line is focused. Stations outside the focused line remain black.
Completed phase segments and stations are thicker;
suburban segments retain their dashed style.

Only one phase can be edited at a time. **Build** saves it to the right sidebar,
with its line, distance, and ordered station list, and clears the editor.
**Add Phase** then becomes available for the next phase. Each Build appends
to the saved plan rather than replacing it, and all saved phases remain
highlighted on the map. A new draft does not change previously saved phases.
These are planning assignments, not changes to recorded opening dates.
Each saved phase has a **Clear** button at its top-right corner. In construction
mode, it deletes only that phase and its highlights, keeping other saved phases
and the current draft unchanged. Its stations become available again unless
they are opened stations or still included in another saved phase. Remaining
phase numbers are not changed.
The trash-can button beside Build clears only the current draft's station and
line selections and its preview highlight. It keeps the phase editor and phase
number, cancels map picking, and leaves all saved phases and their highlights
unchanged. It is disabled when there is no current draft.

**Travel mode** disables/greys the construction editor and restores the previous
travel year and footer settings. Draft phase inputs and the built summary are
retained when switching modes; **Edit construction plan** resumes them.
Plans are kept in this page session only, not saved across a page reload.

This is a planning preview, not live transit guidance: the dataset includes
proposed routes and schematic transfers, with no timetables or service status.

Run the tests with `node --test tests/*.test.js` (no packages required).