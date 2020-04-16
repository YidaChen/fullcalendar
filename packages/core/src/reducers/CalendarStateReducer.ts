
import { buildLocale, RawLocaleInfo } from '../datelib/locale'
import { memoize } from '../util/memoize'
import { Action, CalendarState } from './types'
import { PluginHooks, buildPluginHooks } from '../plugin-system'
import { DateEnv } from '../datelib/env'
import { compileOptions } from '../OptionsManager'
import { Calendar } from '../Calendar'
import { StandardTheme } from '../theme/StandardTheme'
import { EventSourceHash } from '../structs/event-source'
import { buildViewSpecs, ViewSpecHash } from '../structs/view-spec'
import { mapHash } from '../util/object'
import { DateProfileGenerator } from '../DateProfileGenerator'
import { reduceViewType } from './view-type'
import { reduceCurrentDate, getInitialDate, getNow } from './current-date'
import { reduceDateProfile } from './date-profile'
import { reduceEventSources } from './eventSources'
import { reduceEventStore } from './eventStore'
import { reduceDateSelection } from './date-selection'
import { reduceSelectedEvent } from './selected-event'
import { reduceEventDrag } from './event-drag'
import { reduceEventResize } from './event-resize'
import { EmitterMixin } from '../common/EmitterMixin'


export class CalendarStateReducer {

  private compileOptions = memoize(compileOptions)
  private buildPluginHooks = memoize(buildPluginHooks)
  private buildDateEnv = memoize(buildDateEnv)
  private buildTheme = memoize(buildTheme)
  private buildViewSpecs = memoize(buildViewSpecs)
  private buildDateProfileGenerator = memoize(buildDateProfileGenerators)


  reduce(state: CalendarState, action: Action, emitter: EmitterMixin, calendar: Calendar): CalendarState {
    let optionOverrides = state.optionOverrides || {}
    let dynamicOptionOverrides = state.dynamicOptionOverrides || {}

    switch (action.type) {
      case 'INIT':
        optionOverrides = action.optionOverrides
        break

      case 'SET_OPTION':
        dynamicOptionOverrides = { ...dynamicOptionOverrides, [action.optionName]: action.optionValue }
        break

      case 'MUTATE_OPTIONS':
        let { updates, removals, isDynamic } = action

        if (Object.keys(updates).length || removals.length) {
          let hash = isDynamic
            ? (dynamicOptionOverrides = { ...dynamicOptionOverrides, updates })
            : (optionOverrides = { ...optionOverrides, updates })

          for (let removal of removals) {
            delete hash[removal]
          }
        }
        break
    }

    let { options, availableLocaleData } = this.compileOptions(optionOverrides, dynamicOptionOverrides)
    emitter.setOptions(options)

    let pluginHooks = this.buildPluginHooks(options.plugins)
    let viewSpecs = this.buildViewSpecs(pluginHooks.views, optionOverrides, dynamicOptionOverrides)
    let prevDateEnv = state.dateEnv
    let dateEnv = this.buildDateEnv(
      options.timeZone,
      options.locale,
      options.weekNumberCalculation,
      options.firstDay,
      options.weekText,
      pluginHooks,
      availableLocaleData
    )
    let dateProfileGenerators = this.buildDateProfileGenerator(viewSpecs, dateEnv)
    let theme = this.buildTheme(options, pluginHooks)

    let viewType = state.viewType || options.initialView || pluginHooks.initialView // weird how we do INIT
    viewType = reduceViewType(viewType, action, pluginHooks.views)

    let currentDate = state.currentDate || getInitialDate(options, dateEnv) // weird how we do INIT
    let dateProfileGenerator = dateProfileGenerators[viewType]
    let dateProfile = reduceDateProfile(state.dateProfile, action, currentDate, dateProfileGenerator)
    currentDate = reduceCurrentDate(currentDate, action, dateProfile)

    let eventSources = reduceEventSources(state.eventSources, action, dateProfile, pluginHooks, options, emitter, calendar)

    let nextState = {
      ...state, // preserve previous state from plugin reducers
      optionOverrides,
      dynamicOptionOverrides,
      options,
      dateEnv,
      pluginHooks,
      availableRawLocales: availableLocaleData.map,
      theme,
      viewSpecs,
      viewType,
      dateProfileGenerator,
      dateProfile,
      currentDate,
      eventSources,
      eventStore: reduceEventStore(state.eventStore, action, eventSources, dateProfile, dateEnv, prevDateEnv, calendar),
      dateSelection: reduceDateSelection(state.dateSelection, action),
      eventSelection: reduceSelectedEvent(state.eventSelection, action),
      eventDrag: reduceEventDrag(state.eventDrag, action),
      eventResize: reduceEventResize(state.eventResize, action),
      eventSourceLoadingLevel: computeLoadingLevel(eventSources),
      loadingLevel: computeLoadingLevel(eventSources)
    }

    for (let reducerFunc of pluginHooks.reducers) {
      nextState = reducerFunc(nextState, action, options, calendar)
    }

    return nextState
  }
}


function buildDateEnv(
  timeZone: string,
  explicitLocale: string,
  weekNumberCalculation,
  firstDay,
  weekText,
  pluginHooks: PluginHooks,
  availableLocaleData: RawLocaleInfo
) {
  let locale = buildLocale(explicitLocale || availableLocaleData.defaultCode, availableLocaleData.map)

  return new DateEnv({
    calendarSystem: 'gregory', // TODO: make this a setting
    timeZone: timeZone,
    namedTimeZoneImpl: pluginHooks.namedTimeZonedImpl,
    locale,
    weekNumberCalculation,
    firstDay,
    weekText,
    cmdFormatter: pluginHooks.cmdFormatter
  })
}


function buildTheme(rawOptions, pluginHooks: PluginHooks) {
  let ThemeClass = pluginHooks.themeClasses[rawOptions.themeSystem] || StandardTheme

  return new ThemeClass(rawOptions)
}


function buildDateProfileGenerators(viewSpecs: ViewSpecHash, dateEnv: DateEnv) {
  return mapHash(viewSpecs, (viewSpec) => {
    let DateProfileGeneratorClass = viewSpec.options.dateProfileGeneratorClass || DateProfileGenerator

    return new DateProfileGeneratorClass(viewSpec, dateEnv, getNow(viewSpec.options, dateEnv))
  })
}


function computeLoadingLevel(eventSources: EventSourceHash): number {
  let cnt = 0

  for (let sourceId in eventSources) {
    if (eventSources[sourceId].isFetching) {
      cnt++
    }
  }

  return cnt
}