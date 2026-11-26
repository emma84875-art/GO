// Flight discovery views: the homepage, the search form and the results. Plain DOM, text via textContent.
//
// Nothing here books, pays, issues tickets or collects passport details. The booking button is shown
// disabled, so the customer can see what comes next without a path to pay.

import config from '../config.js';
import { el } from './dom.js';
import { searchFlights } from './flight-client.js';
import {
  DEPARTURE_WINDOWS,
  DISPLAY_CURRENCY,
  SORT_OPTIONS,
  STOPS_OPTIONS,
  airportLabel,
  hasDates,
  inputFromParams,
  optionsFromParams,
  paramsFromInput,
  searchHash,
  todayInLagos,
  validateInput,
} from './flight-logic.js';
import { airlinesIn, buildResultCards } from './flight-view.js';
import { findAirport, searchAirports } from '../vendor/packages/flights/src/airports.js';
import { CABIN_CLASSES, CABIN_LABELS, MAX_TRAVELLERS } from '../vendor/packages/flights/src/search.js';

const CACHE_LIMIT = 20;
// After this long without an answer, the page says the service may be waking up. The search keeps running.
const WAKING_MESSAGE_MS = 5000;
const POPULAR_DESTINATIONS = ['LHR', 'DXB', 'JFK', 'CDG', 'IST', 'ACC'];
const UNAVAILABLE_TEXT = {
  not_configured: 'Live flight results are not connected to this version of GO yet. GO does not show example or estimated fares in their place. Your search details are kept above.',
  timeout: 'The flight provider did not answer in time. Please try again in a few minutes.',
  provider_error: 'The flight provider could not complete this search. Please try again later.',
  invalid_response: 'We could not read the flight results. Please try again later.',
  production_not_approved: 'Live flight results are not approved for this version of GO yet.',
  fx_unavailable: 'Prices are not available right now. Try again later.',
};

// Results are kept in memory only (never storage), for the length of the page session.
const cache = new Map();
let activeRequest = 0;

function remember(key, outcome) {
  cache.set(key, outcome);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function notice(text, kind = 'info') {
  return el('p', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status', text });
}

function countText(value) {
  return Number.isSafeInteger(value) ? String(value) : '';
}

function setError(control, errorEl, message, baseIds = '') {
  errorEl.textContent = message;
  errorEl.hidden = !message;
  if (message) {
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', [baseIds, errorEl.id].filter(Boolean).join(' '));
  } else {
    control.removeAttribute('aria-invalid');
    if (baseIds) control.setAttribute('aria-describedby', baseIds);
    else control.removeAttribute('aria-describedby');
  }
}

function fieldBlock(id, labelText, control, extra = []) {
  const error = el('p', { id: `${id}-error`, class: 'field-error', hidden: true });
  return { error, element: el('div', { class: 'field' }, [el('label', { for: id, text: labelText }), control, ...extra, error]) };
}

// Airport picker: an accessible combobox with a listbox. Keyboard: arrows move, Enter chooses, Escape closes.
function airportField(id, labelText, code) {
  const listId = `${id}-options`;
  const helpId = `${id}-help`;
  const input = el('input', {
    id,
    type: 'text',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-required': 'true',
    'aria-describedby': helpId,
    placeholder: 'City or airport code',
  });
  if (code) {
    input.value = airportLabel(code);
    input.dataset.iata = code;
  }
  const list = el('ul', { id: listId, role: 'listbox', class: 'options', hidden: true, 'aria-label': `${labelText} airports` });
  let options = [];
  let active = -1;

  const setExpanded = (open) => input.setAttribute('aria-expanded', String(open));
  function close() {
    list.hidden = true;
    setExpanded(false);
    active = -1;
    input.removeAttribute('aria-activedescendant');
  }
  function paint() {
    [...list.children].forEach((item, index) => {
      item.setAttribute('aria-selected', String(index === active));
      item.classList.toggle('active', index === active);
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function choose(airport) {
    input.value = `${airport.city} (${airport.iata})`;
    input.dataset.iata = airport.iata;
    close();
  }
  function show(query) {
    options = searchAirports(query);
    list.replaceChildren(...options.map((airport, index) => el('li', {
      id: `${listId}-${index}`,
      role: 'option',
      class: 'option',
      'aria-selected': 'false',
      text: `${airport.city} (${airport.iata}), ${airport.name}`,
      onmousedown: (event) => {
        event.preventDefault();
        choose(airport);
      },
    })));
    active = -1;
    list.hidden = options.length === 0;
    setExpanded(options.length > 0);
  }

  input.addEventListener('input', () => {
    delete input.dataset.iata;
    show(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (list.hidden || options.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      paint();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(options[active]);
    }
  });
  input.addEventListener('blur', close);

  // An airport counts only if it was chosen from the list, or typed as a known three-letter code.
  const read = () => {
    if (input.dataset.iata) return input.dataset.iata;
    const typed = input.value.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(typed) && findAirport(typed) ? typed : '';
  };

  const help = el('p', { id: helpId, class: 'help', text: 'Suggestions come from a short demonstration list, not every airport. You can type any three-letter airport code.' });
  const error = el('p', { id: `${id}-error`, class: 'field-error', hidden: true });
  return {
    input,
    error,
    help: helpId,
    read,
    // The list overlays the page under the input. It must not push the layout down, or a tap on the
    // search button can land on a shifted control while the list closes.
    element: el('div', { class: 'field airport' }, [
      el('label', { for: id, text: labelText }),
      el('div', { class: 'combo' }, [input, list]),
      help,
      error,
    ]),
  };
}

function selectControl(id, labelText, entries, value, onChange) {
  return el('div', { class: 'control' }, [
    el('label', { for: id, text: labelText }),
    el('select', { id, onchange: (event) => onChange(event.target.value) }, entries.map(([optionValue, text]) => el('option', {
      value: optionValue,
      text,
      selected: optionValue === value,
    }))),
  ]);
}

// The search form, used on the homepage and on the search page. Validation uses the shared rules
// (packages/flights), so the form and the server agree on what is valid.
const MIN_JOURNEYS = 2;
const MAX_JOURNEYS = 6;

function buildSearchForm(initial, { today, compact = false }) {
  const from = airportField('from', 'From', initial.origin ?? '');
  const to = airportField('to', 'To', initial.destination ?? '');
  const depart = el('input', { id: 'depart', type: 'date', min: today, value: initial.departureDate, 'aria-required': 'true' });
  const returnInput = el('input', { id: 'return', type: 'date', min: today, value: initial.returnDate ?? '', 'aria-required': 'true' });
  const departField = fieldBlock('depart', 'Departure date', depart);
  const returnField = fieldBlock('return', 'Return date', returnInput);

  // Multi-city journeys: two to six rows, each with its own airports and date, in travel order. The rows
  // are rebuilt when one is added or removed, after their current values have been kept.
  let legRows = [];
  const legsList = el('div', { class: 'legs-list' });
  const addButton = el('button', { type: 'button', class: 'secondary', text: 'Add a journey' });
  // Not 'legs': that class already lays out the journey timeline on result cards.
  const legsWrap = el('section', { class: 'journeys-form', 'aria-labelledby': 'legs-title' }, [
    el('h2', { id: 'legs-title', class: 'legs-title', text: 'Journeys in order' }),
    legsList,
    el('div', { class: 'actions' }, [addButton]),
  ]);

  function readLegRows() {
    return legRows.map((row) => ({ origin: row.origin.read(), destination: row.destination.read(), departureDate: row.date.value }));
  }

  function renderLegs(values) {
    legRows = values.map((leg, index) => {
      const prefix = `leg${index + 1}`;
      const origin = airportField(`${prefix}-from`, `Journey ${index + 1}: from`, leg.origin ?? '');
      const destination = airportField(`${prefix}-to`, `Journey ${index + 1}: to`, leg.destination ?? '');
      const date = el('input', { id: `${prefix}-date`, type: 'date', min: today, value: leg.departureDate ?? '', 'aria-required': 'true' });
      const dateField = fieldBlock(`${prefix}-date`, `Journey ${index + 1}: date`, date);
      const remove = el('button', {
        type: 'button',
        class: 'secondary',
        text: `Remove journey ${index + 1}`,
        disabled: values.length <= MIN_JOURNEYS,
        onclick: () => renderLegs(readLegRows().filter((_, position) => position !== index)),
      });
      const element = el('div', { class: 'leg' }, [origin.element, destination.element, dateField.element, el('div', { class: 'leg-remove' }, [remove])]);
      return { index, origin, destination, date, dateField, element };
    });
    legsList.replaceChildren(...legRows.map((row) => row.element));
    addButton.disabled = legRows.length >= MAX_JOURNEYS;
  }

  addButton.addEventListener('click', () => {
    const current = readLegRows();
    const previous = current.at(-1);
    // A new journey starts where the last one ends, and on the same day, so the common case needs less typing.
    renderLegs([...current, { origin: previous?.destination ?? '', destination: '', departureDate: previous?.departureDate ?? '' }]);
  });

  const initialLegs = initial.legs ?? [];
  renderLegs(initialLegs.length >= MIN_JOURNEYS ? initialLegs : [...initialLegs, ...Array.from({ length: MIN_JOURNEYS - initialLegs.length }, () => ({}))]);

  const adults = el('input', { id: 'adults', type: 'number', inputmode: 'numeric', min: '1', max: String(MAX_TRAVELLERS), value: countText(initial.passengers.adults) });
  const children = el('input', { id: 'children', type: 'number', inputmode: 'numeric', min: '0', max: String(MAX_TRAVELLERS), value: countText(initial.passengers.children) });
  const infants = el('input', { id: 'infants', type: 'number', inputmode: 'numeric', min: '0', max: String(MAX_TRAVELLERS), value: countText(initial.passengers.infants) });
  const paxError = el('p', { id: 'passengers-error', class: 'field-error', hidden: true });
  const travellers = el('fieldset', { class: 'travellers' }, [
    el('legend', { text: 'Travellers' }),
    el('div', { class: 'counts' }, [
      el('div', { class: 'field' }, [el('label', { for: 'adults', text: 'Adults (12+)' }), adults]),
      el('div', { class: 'field' }, [el('label', { for: 'children', text: 'Children (2 to 11)' }), children]),
      el('div', { class: 'field' }, [el('label', { for: 'infants', text: 'Infants (under 2)' }), infants]),
    ]),
    paxError,
  ]);

  const cabin = el('select', { id: 'cabin' }, CABIN_CLASSES.map((value) => el('option', { value, text: CABIN_LABELS[value], selected: value === initial.cabin })));
  const cabinField = fieldBlock('cabin', 'Cabin', cabin);

  const trip = el('fieldset', { class: 'trip' }, [
    el('legend', { text: 'Trip type' }),
    el('div', { class: 'choices' }, [
      ['one_way', 'One-way'],
      ['round_trip', 'Return'],
      ['multi_city', 'Multi-city'],
    ].map(([value, label]) => el('label', { class: 'choice', for: `trip-${value}` }, [
      el('input', { id: `trip-${value}`, type: 'radio', name: 'trip', value, checked: value === initial.tripType }),
      el('span', { text: label }),
    ]))),
  ]);
  // Shows the fields for the chosen trip type. One-way and return use the single journey fields; multi-city
  // uses the journeys list, and the single journey fields are hidden (they are not read in that case).
  function applyTrip(tripType) {
    const multi = tripType === 'multi_city';
    for (const node of [from.element, to.element, departField.element]) node.hidden = multi;
    returnField.element.hidden = tripType !== 'round_trip';
    legsWrap.hidden = !multi;
  }
  for (const radio of trip.querySelectorAll('input[name="trip"]')) {
    radio.addEventListener('change', () => applyTrip(radio.value));
  }
  applyTrip(initial.tripType);

  const summary = el('div', { class: 'error-summary', id: 'form-errors', tabindex: '-1', role: 'alert', hidden: true }, [
    el('h2', { text: 'Please check these details' }),
    el('ul', { id: 'form-error-list' }),
  ]);
  const summaryList = summary.querySelector('#form-error-list');

  const targets = {
    origin: { control: from.input, error: from.error, base: from.help },
    destination: { control: to.input, error: to.error, base: to.help },
    departureDate: { control: depart, error: departField.error },
    returnDate: { control: returnInput, error: returnField.error },
    passengers: { control: adults, error: paxError },
    cabin: { control: cabin, error: cabinField.error },
  };

  function showErrors(errors, focus = true) {
    for (const [key, target] of Object.entries(targets)) {
      setError(target.control, target.error, errors[key] ?? '', target.base ?? '');
    }
    for (const row of legRows) {
      const base = `legs.${row.index}`;
      setError(row.origin.input, row.origin.error, errors[`${base}.origin`] ?? '', row.origin.help);
      setError(row.destination.input, row.destination.error, errors[`${base}.destination`] ?? '', row.destination.help);
      setError(row.date, row.dateField.error, errors[`${base}.departureDate`] ?? '', '');
    }
    const messages = Object.values(errors);
    summaryList.replaceChildren(...messages.map((message) => el('li', { text: message })));
    summary.hidden = messages.length === 0;
    if (messages.length > 0 && focus) summary.focus();
  }

  function readInput() {
    const chosen = trip.querySelector('input[name="trip"]:checked')?.value;
    const tripType = chosen === 'round_trip' || chosen === 'multi_city' ? chosen : 'one_way';
    const count = (node) => (node.value === '' ? Number.NaN : Number(node.value));
    if (tripType === 'multi_city') {
      return {
        tripType,
        legs: readLegRows(),
        passengers: { adults: count(adults), children: count(children), infants: count(infants) },
        cabin: cabin.value,
        displayCurrency: DISPLAY_CURRENCY,
      };
    }
    return {
      tripType,
      origin: from.read(),
      destination: to.read(),
      departureDate: depart.value,
      ...(tripType === 'round_trip' ? { returnDate: returnInput.value } : {}),
      passengers: { adults: count(adults), children: count(children), infants: count(infants) },
      cabin: cabin.value,
      displayCurrency: DISPLAY_CURRENCY,
    };
  }

  const form = el('form', {
    class: compact ? 'search compact' : 'search',
    novalidate: 'novalidate',
    'aria-label': 'Flight search',
    onsubmit: (event) => {
      event.preventDefault();
      const input = readInput();
      const errors = validateInput(input, today);
      showErrors(errors, true);
      if (Object.keys(errors).length === 0) location.hash = `#/search?${paramsFromInput(input).toString()}`;
    },
  }, [
    summary,
    trip,
    el('div', { class: 'grid' }, [
      from.element,
      to.element,
      departField.element,
      returnField.element,
      legsWrap,
      travellers,
      cabinField.element,
    ]),
    el('div', { class: 'actions' }, [el('button', { type: 'submit', class: 'primary', text: 'Search flights' })]),
  ]);

  return { element: form, showErrors };
}

// Plain notices for offers the service left out. Nothing is hidden: the count and the reason are shown.
function exclusionNotices(excluded) {
  const nodes = [];
  if (!excluded) return nodes;
  if (excluded.invalidCurrency > 0) {
    const n = excluded.invalidCurrency;
    const codes = excluded.currencies.length > 0 ? ` (${excluded.currencies.join(', ')})` : '';
    nodes.push(notice(
      `${n} ${n === 1 ? 'flight offer was' : 'flight offers were'} left out because the price currency is not one GO can show safely yet${codes}, or the currency code was not recognised. GO does not convert prices, so ${n === 1 ? 'it is' : 'they are'} not shown.`,
      'warning',
    ));
  }
  if (excluded.invalidPrice > 0) {
    const n = excluded.invalidPrice;
    nodes.push(notice(`${n} ${n === 1 ? 'flight offer was' : 'flight offers were'} left out because the price was not valid.`, 'warning'));
  }
  if (excluded.malformed > 0) {
    const n = excluded.malformed;
    nodes.push(notice(`${n} ${n === 1 ? 'flight offer was' : 'flight offers were'} left out because the airline's details could not be read.`, 'warning'));
  }
  return nodes;
}

function anyExcluded(excluded) {
  return Boolean(excluded) && (excluded.invalidCurrency > 0 || excluded.invalidPrice > 0 || excluded.malformed > 0);
}

function sourceNote(source) {
  if (source.mode === 'production') return notice('Live results from the flight supplier. Prices can change until you book.');
  if (source.mode === 'sandbox') return notice('Sandbox results. These are supplier test fares, not live fares, and cannot be booked in this build.', 'warning');
  return notice('Development fixture. These are not real flights.', 'warning');
}

function toolbar(offers, options, params) {
  const go = (values) => {
    location.hash = searchHash(params, values);
  };
  return el('div', { class: 'toolbar', role: 'group', 'aria-label': 'Sort and filter results' }, [
    selectControl('sort', 'Sort by', Object.entries(SORT_OPTIONS), options.sort, (value) => go({ sort: value })),
    selectControl('stops', 'Stops', Object.entries(STOPS_OPTIONS), options.stops, (value) => go({ stops: value === 'any' ? '' : value })),
    selectControl(
      'dep',
      'Departure time',
      Object.entries(DEPARTURE_WINDOWS).map(([key, value]) => [key, value.label]),
      options.departure,
      (value) => go({ dep: value === 'any' ? '' : value }),
    ),
    selectControl(
      'airline',
      'Airline',
      [['', 'All airlines'], ...airlinesIn(offers).map((code) => [code, `Carrier ${code}`])],
      options.airline,
      (value) => go({ airline: value }),
    ),
    el('div', { class: 'control check' }, [
      el('input', { id: 'bags', type: 'checkbox', checked: options.checkedBags, onchange: (event) => go({ bags: event.target.checked ? '1' : '' }) }),
      el('label', { for: 'bags', text: 'Checked bag included' }),
    ]),
  ]);
}

function journeyNode(label, journey) {
  return el('div', { class: 'journey' }, [
    el('p', { class: 'journey-label', text: label }),
    el('div', { class: 'legs' }, [
      el('div', { class: 'point' }, [
        el('span', { class: 'time', text: journey.from.time }),
        el('span', { class: 'place', text: journey.from.airport }),
        el('span', { class: 'day', text: journey.from.day }),
      ]),
      el('div', { class: 'middle' }, [
        el('span', { class: 'duration', text: journey.duration }),
        el('span', { class: 'stops', text: journey.stops.text }),
      ]),
      el('div', { class: 'point end' }, [
        el('span', { class: 'time', text: journey.to.time }),
        el('span', { class: 'place', text: journey.to.airport }),
        el('span', { class: 'day', text: journey.to.dayOffset > 0 ? `${journey.to.day} (+${journey.to.dayOffset} day)` : journey.to.day }),
      ]),
    ]),
    el('p', { class: 'flights', text: `Carrier ${journey.carrier} · ${journey.flightNumbers}` }),
  ]);
}

function cardNode(card) {
  return el('li', { class: 'card flight' }, [
    el('div', { class: 'flight-main' }, card.journeys.map((journey) => journeyNode(journey.label, journey.view))),
    el('div', { class: 'flight-side' }, [
      el('div', { class: 'price' }, [
        el('p', { class: 'amount', text: card.price }),
        el('p', { class: 'help', text: `Fare currency: ${card.currencyCode}` }),
        el('p', { class: 'help', text: `Total fare. Price valid until ${card.expiresLabel}.` }),
        el('p', { class: 'help', text: card.priceNote }),
      ]),
      el('div', { class: 'baggage' }, [
        el('h3', { text: 'Baggage' }),
        el('ul', {}, card.baggage.map((line) => el('li', { text: line }))),
      ]),
      el('details', { class: 'conditions' }, [
        el('summary', { text: 'Refunds, changes and restrictions' }),
        el('ul', {}, card.conditions.map((line) => el('li', { text: line }))),
      ]),
      el('button', { type: 'button', class: 'primary', disabled: true, text: 'Booking is not available yet' }),
      el('p', { class: 'help', text: 'GO does not take payment or issue tickets in this build.' }),
    ]),
  ]);
}

function resultsBlock(outcome, options, params) {
  const model = buildResultCards(outcome.offers, options, params.trip, DISPLAY_CURRENCY);
  const nodes = [sourceNote(outcome.source), ...exclusionNotices(outcome.excluded), toolbar(outcome.offers, options, params)];
  nodes.splice(1, 0, notice('Each fare is shown in the currency the airline sells it in. GO does not convert prices, so no fare is converted to another currency.'));
  if (model.mixedCurrencies) {
    nodes.push(notice('These prices are in more than one currency. Compare fares only within the same currency.', 'warning'));
  }
  // Infant fares are not verified against the supplier yet, so the page never presents them as confirmed.
  if (Number(params.infants) > 0) {
    nodes.push(notice('Infant fares are not confirmed for this search. Check the airline before you travel.', 'warning'));
  }
  nodes.push(el('p', { class: 'count', role: 'status', text: `Showing ${model.shown} of ${model.total} flights` }));
  if (model.shown === 0) {
    nodes.push(notice('No flights match these filters.'));
    nodes.push(el('p', {}, [el('a', {
      href: searchHash(params, { stops: '', dep: '', airline: '', bags: '' }),
      text: 'Clear the filters',
    })]));
  } else {
    nodes.push(el('ol', { class: 'cards', 'aria-label': 'Flight results' }, model.cards.map(cardNode)));
  }
  return nodes;
}

function unavailableBlock(outcome, retry) {
  const text = UNAVAILABLE_TEXT[outcome.reason] ?? 'Flight results are not available right now. Please try again later.';
  const nodes = [el('div', { class: 'card' }, [el('h2', { text: 'Flight results are not available' }), el('p', { text })])];
  if (outcome.reason !== 'not_configured') {
    nodes.push(el('p', {}, [el('button', { type: 'button', class: 'primary', text: 'Try again', onclick: retry })]));
  }
  return nodes;
}

function paint(results, outcome, params, retry) {
  const options = optionsFromParams(params);
  switch (outcome.status) {
    case 'ok':
      return results.replaceChildren(...resultsBlock(outcome, options, params));
    case 'empty':
      if (anyExcluded(outcome.excluded)) {
        return results.replaceChildren(el('div', { class: 'card' }, [
          el('h2', { text: 'No flights can be shown' }),
          el('p', { text: 'The airline returned results, but GO could not show any of them. The reasons are below.' }),
          ...exclusionNotices(outcome.excluded),
        ]));
      }
      return results.replaceChildren(el('div', { class: 'card' }, [
        el('h2', { text: 'No flights found' }),
        el('p', { text: 'No flights match these details. Try another date, a nearby airport or a different cabin.' }),
      ]));
    case 'unavailable':
      return results.replaceChildren(...unavailableBlock(outcome, retry));
    default:
      return results.replaceChildren(notice('Check your search details and try again.', 'error'));
  }
}

function renderOutcome(results, params, input, today) {
  const key = paramsFromInput(input).toString();
  const retry = () => {
    cache.delete(key);
    renderOutcome(results, params, input, today);
  };
  const cached = cache.get(key);
  if (cached) return paint(results, cached, params, retry);

  const token = ++activeRequest;
  results.replaceChildren(el('p', { class: 'notice info', role: 'status', 'aria-busy': 'true', text: 'Searching flights…' }));
  const waking = setTimeout(() => {
    if (token !== activeRequest || !results.isConnected) return;
    results.replaceChildren(el('p', {
      class: 'notice info',
      role: 'status',
      'aria-busy': 'true',
      text: 'Waking up the flight search service. On the free plan the first search after a quiet spell can take about a minute. Your search is still running.',
    }));
  }, WAKING_MESSAGE_MS);
  searchFlights(input, today)
    .then((outcome) => {
      if (token !== activeRequest || !results.isConnected) return;
      if (outcome.status !== 'invalid') remember(key, outcome);
      paint(results, outcome, params, retry);
    })
    .catch(() => {
      if (token !== activeRequest || !results.isConnected) return;
      paint(results, { status: 'unavailable', reason: 'provider_error' }, params, retry);
    })
    .finally(() => clearTimeout(waking));
}

export function viewSearch(params = {}) {
  const today = todayInLagos();
  const initial = inputFromParams(params);
  const form = buildSearchForm(initial, { today });
  const results = el('div', { class: 'results' });
  const page = el('section', { class: 'search-page' }, [el('h1', { text: 'Search flights' }), form.element, results]);

  if (!hasDates(params)) {
    results.append(notice('Choose your dates to see flights.'));
    return page;
  }
  const errors = validateInput(initial, today);
  if (Object.keys(errors).length > 0) {
    form.showErrors(errors, false);
    return page;
  }
  renderOutcome(results, params, initial, today);
  return page;
}

// Support contact details come only from config.js (SUPPORT_EMAIL and SUPPORT_PHONE). When they are not set,
// the page says they are not published yet. No contact details are ever made up.
const EMAIL_SHAPE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function supportBlock() {
  const email = typeof config.SUPPORT_EMAIL === 'string' && EMAIL_SHAPE.test(config.SUPPORT_EMAIL) ? config.SUPPORT_EMAIL : null;
  const phone = typeof config.SUPPORT_PHONE === 'string' && config.SUPPORT_PHONE.trim() !== '' ? config.SUPPORT_PHONE.trim() : null;
  if (!email && !phone) {
    return el('p', { text: 'Support contact details are not published yet.' });
  }
  return el('ul', { class: 'contact' }, [
    email ? el('li', {}, [el('a', { href: `mailto:${email}`, text: email })]) : null,
    phone ? el('li', { text: phone }) : null,
  ].filter(Boolean));
}

export function viewHome() {
  const today = todayInLagos();
  const form = buildSearchForm(inputFromParams({ from: 'LOS', trip: 'one_way' }), { today, compact: true });
  return el('div', { class: 'home' }, [
    el('section', { class: 'hero' }, [
      el('div', { class: 'hero-copy' }, [
        el('p', { class: 'eyebrow', text: 'Flights from Nigeria to the world' }),
        el('h1', { text: 'Find your flight, with the conditions in plain view' }),
        el('p', {
          class: 'lede',
          text: 'GO shows each result’s baggage, refund and change terms as the airline states them. Where a detail is not confirmed, GO says so instead of guessing.',
        }),
      ]),
      el('div', { class: 'hero-search' }, [form.element]),
    ]),
    el('section', { class: 'benefits', 'aria-labelledby': 'benefits-title' }, [
      el('h2', { id: 'benefits-title', text: 'Why book with GO' }),
      el('ul', { class: 'benefit-list' }, [
        el('li', {}, [el('h3', { text: 'Conditions up front' }), el('p', { text: 'Baggage, refund and change terms appear on every result, not only at the last step.' })]),
        el('li', {}, [el('h3', { text: 'Unconfirmed means unconfirmed' }), el('p', { text: 'If an airline has not confirmed a detail, GO labels it as not confirmed.' })]),
        el('li', {}, [el('h3', { text: 'One clear total' }), el('p', { text: 'Each result shows one total fare and the time until its price is valid.' })]),
      ]),
    ]),
    el('section', { class: 'destinations', 'aria-labelledby': 'destinations-title' }, [
      el('h2', { id: 'destinations-title', text: 'Popular destinations from Lagos' }),
      el('ul', { class: 'destination-list' }, POPULAR_DESTINATIONS.map((code) => el('li', {}, [
        el('a', { class: 'destination', href: `#/search?trip=one_way&from=LOS&to=${code}`, text: `${airportLabel(code)}` }),
      ]))),
      el('p', { class: 'help', text: 'Choose a destination to start a search. Dates are still needed before any flights are shown.' }),
    ]),
    el('section', { class: 'info', 'aria-labelledby': 'info-title' }, [
      el('h2', { id: 'info-title', text: 'Before you travel' }),
      el('ul', {}, [
        el('li', { text: 'Check that your passport is valid for your whole trip, and check entry rules on the destination country’s official government site.' }),
        el('li', { text: 'Check the checked and cabin baggage allowance on your result before you travel. Allowances can differ by airline and by fare.' }),
        el('li', { text: 'Plan to reach the airport in good time. Check-in opening and closing times are set by the airline and the airport.' }),
      ]),
    ]),
    el('section', { class: 'support', 'aria-labelledby': 'support-title' }, [
      el('h2', { id: 'support-title', text: 'Need help?' }),
      supportBlock(),
    ]),
  ]);
}
