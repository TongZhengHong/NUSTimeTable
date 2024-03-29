import {
  castArray,
  //   difference,
  //   each,
  first,
  // flatMapDeep,
  //   get,
  groupBy,
  invert,
  isEmpty,
  isEqual,
  last,
  map,
  mapValues,
  //   omitBy,
  //   partition,
  pick,
  range,
  sample,
  values,
} from 'lodash';
// import { addDays, min as minDate, parseISO } from 'date-fns';

import {
  ClassNo,
  // consumeWeeks,
  LessonType,
  Module,
  ModuleCode,
  NumericWeeks,
  RawLesson,
  Semester,
} from '../types/modules';

import {
  ColoredLesson,
  HoverLesson,
  Lesson,
  ModuleLessonConfig,
  ModulesMap,
  SemTimetableConfig,
  SemTimetableConfigWithLessons,
  TimetableArrangement,
  TimetableDayArrangement,
  TimetableDayFormat,
} from '../types/timetable';

// import { ModuleCodeMap, ModulesMap } from 'types/reducers';
// import { ExamClashes } from 'types/views';

import { getTimeAsDate } from './timeUtils';
// import { getModuleSemesterData, getModuleTimetable } from './modules';
// import { deltas } from './array';
import qs from 'querystring';
import { areLessonsSameClass, getModuleRawLessons } from './moduleUtils';

type lessonTypeAbbrev = { [lessonType: string]: string };
export const LESSON_TYPE_ABBREV: lessonTypeAbbrev = {
  'Design Lecture': 'DLEC',
  Laboratory: 'LAB',
  Lecture: 'LEC',
  'Packaged Lecture': 'PLEC',
  'Packaged Tutorial': 'PTUT',
  Recitation: 'REC',
  'Sectional Teaching': 'SEC',
  'Seminar-Style Module Class': 'SEM',
  Tutorial: 'TUT',
  'Tutorial Type 2': 'TUT2',
  'Tutorial Type 3': 'TUT3',
  Workshop: 'WS',
};

// Reverse lookup map of LESSON_TYPE_ABBREV
export const LESSON_ABBREV_TYPE: { [key: string]: LessonType } =
  invert(LESSON_TYPE_ABBREV);

// Used for module config serialization - these must be query string safe
// See: https://stackoverflow.com/a/31300627
export const LESSON_TYPE_SEP = ':';
export const LESSON_SEP = ',';

const EMPTY_OBJECT = {};

export function isValidSemester(semester: Semester): boolean {
  return semester >= 1 && semester <= 4;
}

/**
 * Returns a random configuration of a module's timetable lessons.
 * Contains every lessonType from RawLesson[]. Used when a module is first added.
 *
 * TODO: Suggest a configuration that does not clash with itself.
 * ```
 * {
 *    lessonType1: ClassNo1,
 *    lessonType2: ClassNo2,
 *    lessonType3: ClassNo3,
 * }
 * ```
 * @param lessons
 * @returns
 */
export function randomModuleLessonConfig(
  lessons: readonly RawLesson[]
): ModuleLessonConfig {
  const lessonByType: { [lessonType: string]: readonly RawLesson[] } = groupBy(
    lessons,
    (lesson) => lesson.lessonType
  );

  const lessonByClassNo: {
    [lessonType: string]: { [classNo: string]: readonly RawLesson[] };
  } = mapValues(lessonByType, (lessonsSameType: readonly RawLesson[]) =>
    groupBy(lessonsSameType, (lesson) => lesson.classNo)
  );

  return mapValues(
    lessonByClassNo,
    (group: { [classNo: string]: readonly RawLesson[] }) =>
      (first(sample(group)) as RawLesson).classNo
  );
}

/**
 * Replaces ClassNo in SemTimetableConfig with Lesson[]
 *
 * @param semTimetableConfig
 * @param modules
 * @param semester
 * @returns `SemTimetableConfigWithLessons`
 */
export function populateSemTimetableWithLessons(
  semTimetableConfig: SemTimetableConfig,
  modules: ModulesMap,
  semester: Semester
): SemTimetableConfigWithLessons {
  return mapValues(
    semTimetableConfig,
    (moduleLessonConfig: ModuleLessonConfig, moduleCode: ModuleCode) => {
      const module: Module = modules[moduleCode];
      if (!module) return EMPTY_OBJECT;

      return mapValues(
        moduleLessonConfig,
        (classNo: ClassNo, lessonType: LessonType) => {
          const modSemData = module.semesterData.find(
            (semData) => semData.semester === semester
          );
          const lessons = modSemData?.timetable || [];

          // Find lessons for each `lessonType` and `classNo`
          const newLessons = lessons.filter(
            (lesson: RawLesson): boolean =>
              lesson.lessonType === lessonType && lesson.classNo === classNo
          );

          // Inject `moduleCode` and `title` to convert `RawLesson` -> `Lesson`
          const timetableLessons: Lesson[] = newLessons.map(
            (lesson: RawLesson): Lesson => ({
              ...lesson,
              moduleCode,
              title: module.title,
            })
          );

          return timetableLessons;
        }
      );
    }
  );
}

export function populateActiveLessonClasses(
  activeLesson: Lesson,
  timetableLessons: Lesson[],
  currentSem: number,
  modules: ModulesMap
) {
  const activeLessonCode = activeLesson.moduleCode;
  const activeLessonModule = modules[activeLessonCode];
  const moduleLessons = getModuleRawLessons(activeLessonModule, currentSem);

  // Remove activeLesson because it will be added/pushed later
  timetableLessons = timetableLessons.filter(
    (lesson) => !areLessonsSameClass(lesson, activeLesson)
  );

  // Get all lessons of same lessonType as activeLesson
  const sameLessonType = moduleLessons.filter(
    (lesson) => lesson.lessonType === activeLesson.lessonType
  );

  sameLessonType.forEach((lesson) => {
    // Inject module code and title to convert RawLesson -> ModifiableLesson
    const modifiableLesson: Lesson & {
      isActive?: boolean;
      isAvailable?: boolean;
    } = {
      ...lesson,
      moduleCode: activeLessonCode,
      title: activeLessonModule.title,
    };

    // Mark same lessonType and same classNo (Same combo group)
    if (areLessonsSameClass(modifiableLesson, activeLesson))
      modifiableLesson.isActive = true;
    // If not, this is just another option to choose from
    else if (lesson.lessonType === activeLesson.lessonType)
      modifiableLesson.isAvailable = true;

    timetableLessons.push(modifiableLesson);
  });

  return timetableLessons;
}

/**
 * Filters a flat array of lessons and returns the lessons corresponding to lessonType.
 *
 * @param lessons
 * @param lessonType
 * @returns
 */
export function lessonsForLessonType<T extends RawLesson>(
  lessons: readonly T[],
  lessonType: LessonType
): readonly T[] {
  return lessons.filter((lesson) => lesson.lessonType === lessonType);
}

/**
 * Groups flat array of lessons by day.
 * ```
 * {
 *    Monday: [Lesson, Lesson, ...],
 *    Tuesday: [Lesson, ...],
 * }
 * ```
 * @param lessons
 * @returns
 */
export function groupLessonsByDay(
  lessons: ColoredLesson[]
): TimetableDayFormat {
  return groupBy(lessons, (lesson) => lesson.day);
}

/**
 * Determines if two lessons overlap. Conditions:
 *
 * - Both on same day AND
 * - lesson1 startTime before lesson2 endTime AND
 * - lesson1 endTime after lesson2 startTime
 *
 * See: `arrangeLessonsWithinDay`
 * @param lesson1
 * @param lesson2
 * @returns true if overlap and false otherwise
 */
export function doLessonsOverlap(
  lesson1: RawLesson,
  lesson2: RawLesson
): boolean {
  return (
    lesson1.day === lesson2.day &&
    lesson1.startTime < lesson2.endTime &&
    lesson2.startTime < lesson1.endTime
  );
}

/**
 * Converts a flat array of lessons *for ONE day* into rows of lessons within that day row.
 * Result invariants:
 * - Each lesson will not overlap with each other.
 * ```
 * [
 *    [Lesson, Lesson, ...],
 *    [Lesson, ...],
 * ]
 * ```
 * @param lessons
 * @returns
 */
export function arrangeLessonsWithinDay(
  lessons: ColoredLesson[]
): TimetableDayArrangement {
  const rows: TimetableDayArrangement = [[]];
  if (isEmpty(lessons)) return rows;

  // Sort by startTime then by classNo
  const sortedLessons = lessons.sort((a, b) => {
    const timeDiff = a.startTime.localeCompare(b.startTime);
    return timeDiff !== 0 ? timeDiff : a.classNo.localeCompare(b.classNo);
  });

  // Check each lesson if it overlaps with existing classes already populated in rows
  sortedLessons.forEach((lesson: ColoredLesson) => {
    for (let i = 0; i < rows.length; i++) {
      const rowLessons: ColoredLesson[] = rows[i];
      const previousLesson = last(rowLessons); // Only check last lesson since all classes are sorted
      if (!previousLesson || !doLessonsOverlap(previousLesson, lesson)) {
        // Lesson does not overlap with any Lesson in the row. Add it to row.
        rowLessons.push(lesson);
        return;
      }
    }
    // No existing rows are available to fit this lesson in. Append a new row.
    rows.push([lesson]);
  });

  return rows;
}

/**
 * Accepts a flat array of lessons and groups them by day and rows with each day
 * for rendering on the timetable.
 * Clashes in Array<Lesson> will go onto the next row within that day.
 * ```
 * {
 *    Monday: [
 *      [Lesson, Lesson, ...],
 *    ],
 *    Tuesday: [
 *      [Lesson, Lesson, Lesson, ...],
 *      [Lesson, Lesson, ...],
 *      [Lesson, ...],
 *    ],
 *    ...
 * }
 * ```
 * @param lessons
 * @returns `TimetableArrangement`
 */
export function arrangeLessonsForWeek(
  lessons: ColoredLesson[]
): TimetableArrangement {
  const dayLessons = groupLessonsByDay(lessons);
  return mapValues(dayLessons, (dayLesson: ColoredLesson[]) =>
    arrangeLessonsWithinDay(dayLesson)
  );
}

/**
 * Determines if a Lesson on the timetable can be modifiable / dragged around.
 *
 * Condition: There are multiple `ClassNo` for all the Array<Lesson> in a `lessonType`.
 * @param lessons
 * @param lessonType
 * @returns
 */
export function areOtherClassesAvailable(
  lessons: readonly RawLesson[],
  lessonType: LessonType
): boolean {
  const lessonTypeGroups = groupBy<RawLesson>(
    lessons,
    (lesson) => lesson.lessonType
  );
  if (!lessonTypeGroups[lessonType]) {
    // No such lessonType.
    return false;
  }
  return (
    Object.keys(
      groupBy(lessonTypeGroups[lessonType], (lesson) => lesson.classNo)
    ).length > 1
  );
}

// Find all exam clashes between modules in semester
// Returns object associating exam dates with the modules clashing on those dates
// export function findExamClashes(
//   modules: Module[],
//   semester: Semester
// ): ExamClashes {
//   const groupedModules = groupBy(modules, (module) =>
//     get(getModuleSemesterData(module, semester), 'examDate')
//   );
//   delete groupedModules.undefined; // Remove modules without exams
//   return omitBy(groupedModules, (mods) => mods.length === 1); // Remove non-clashing mods
// }

// export function isLessonAvailable(
//   lesson: Lesson,
//   date: Date,
//   weekInfo: Readonly<AcadWeekInfo>
// ): boolean {
//   return consumeWeeks(
//     lesson.weeks,
//     (weeks) => weeks.includes(weekInfo.num as number),
//     (weekRange) => {
//       const end = minDate([parseISO(weekRange.end), date]);
//       for (
//         let current = parseISO(weekRange.start);
//         current <= end;
//         current = addDays(current, 7)
//       ) {
//         if (isEqual(current, date)) return true;
//       }

//       return false;
//     }
//   );
// }

export function isLessonOngoing(lesson: Lesson, currentTime: number): boolean {
  return (
    parseInt(lesson.startTime, 10) <= currentTime &&
    currentTime < parseInt(lesson.endTime, 10)
  );
}

export function getStartTimeAsDate(
  lesson: Lesson,
  date: Date = new Date()
): Date {
  return getTimeAsDate(lesson.startTime, date);
}

export function getEndTimeAsDate(
  lesson: Lesson,
  date: Date = new Date()
): Date {
  return getTimeAsDate(lesson.endTime, date);
}

/**
 * Validates the modules in a timetable. It removes all modules which do not exist in
 * the provided module code map from the timetable and returns that as the first item
 * in the tuple, and the module code of all removed modules as the second item.
 *
 * @param timetable
 * @param moduleCodes
 * @returns {[SemTimetableConfig, ModuleCode[]]}
 */
// export function validateTimetableModules(
//   timetable: SemTimetableConfig,
//   moduleCodes: ModuleCodeMap
// ): [SemTimetableConfig, ModuleCode[]] {
//   const [valid, invalid] = partition(
//     Object.keys(timetable),
//     (moduleCode: ModuleCode) => moduleCodes[moduleCode]
//   );
//   return [pick(timetable, valid), invalid];
// }

/**
 * Validates the lesson config for a specific module. It replaces all lessons
 * which invalid class number with the first available class numbers, and
 * removes lessons that are no longer valid
 * @param semester
 * @param lessonConfig
 * @param module
 */
// export function validateModuleLessons(
//   semester: Semester,
//   lessonConfig: ModuleLessonConfig,
//   module: Module
// ): [ModuleLessonConfig, LessonType[]] {
//   const validatedLessonConfig: ModuleLessonConfig = {};
//   const updatedLessonTypes: string[] = [];

//   const validLessons = getModuleTimetable(module, semester);
//   const lessonsByType = groupBy(validLessons, (lesson) => lesson.lessonType);

//   each(lessonsByType, (lessons: RawLesson[], lessonType: LessonType) => {
//     const classNo = lessonConfig[lessonType];

//     // Check that the lesson exists and is valid. If it is not, insert a random
//     // valid lesson. This covers both
//     //
//     // - lesson type is not in the original timetable (ie. a new lesson type was introduced)
//     //   in which case classNo is undefined and thus would not match
//     // - classNo is not valid anymore (ie. the class was removed)
//     //
//     // If a lesson type is removed, then it simply won't be copied over
//     if (!lessons.some((lesson) => lesson.classNo === classNo)) {
//       validatedLessonConfig[lessonType] = lessons[0].classNo;
//       updatedLessonTypes.push(lessonType);
//     } else {
//       validatedLessonConfig[lessonType] = classNo;
//     }
//   });

//   // Add all of the removed lesson types to the array of updated lesson types
//   updatedLessonTypes.push(
//     ...difference(Object.keys(lessonConfig), Object.keys(lessonsByType))
//   );
//   return [validatedLessonConfig, updatedLessonTypes];
// }

// Get information for all modules present in a semester timetable config
export function getSemesterModules(
  timetable: { [moduleCode: string]: unknown },
  modules: ModulesMap
): Module[] {
  return values(pick(modules, Object.keys(timetable)));
}

function serializeModuleConfig(config: ModuleLessonConfig): string {
  // eg. { Lecture: 1, Laboratory: 2 } => LEC=1,LAB=2
  return map(config, (classNo, lessonType) =>
    [LESSON_TYPE_ABBREV[lessonType], encodeURIComponent(classNo)].join(
      LESSON_TYPE_SEP
    )
  ).join(LESSON_SEP);
}

function parseModuleConfig(
  serialized: string | string[] | null
): ModuleLessonConfig {
  const config: ModuleLessonConfig = {};
  if (!serialized) return config;

  castArray(serialized).forEach((serializedModule) => {
    serializedModule.split(LESSON_SEP).forEach((lesson) => {
      const [lessonTypeAbbr, classNo] = lesson.split(LESSON_TYPE_SEP);
      const lessonType = LESSON_ABBREV_TYPE[lessonTypeAbbr];
      // Ignore unparsable/invalid keys
      if (!lessonType) return;
      config[lessonType] = classNo;
    });
  });

  return config;
}

function deltas(numbers: readonly number[]): number[] {
  const result: number[] = [];
  let previous = numbers[0];
  if (typeof previous !== 'number') return result;

  numbers.slice(1).forEach((element) => {
    result.push(element - previous);
    previous = element;
  });

  return result;
}

/**
 * Formats numeric week number array into something human readable
 *
 * - 1           => Week 1
 * - 1,2         => Weeks 1,2
 * - 1,2,3       => Weeks 1-3
 * - 1,2,3,5,6,7 => Weeks 1-3, 5-7
 */
export function formatNumericWeeks(weeks: NumericWeeks): string | null {
  if (weeks.length === 13) return null;
  if (weeks.length === 1) return `Week ${weeks[0]}`;

  // Check for odd / even weeks. There are more odd weeks then even weeks, so we have to split
  // the length check.
  if (deltas(weeks).every((d) => d === 2)) {
    if (weeks[0] % 2 === 0 && weeks.length >= 6) return 'Even Weeks';
    if (weeks[0] % 2 === 1 && weeks.length >= 7) return 'Odd Weeks';
  }

  // Merge consecutive
  const processed: (number | string)[] = [];
  let start = weeks[0];
  let end = start;

  const mergeConsecutive = () => {
    if (end - start > 2) {
      processed.push(`${start}-${end}`);
    } else {
      processed.push(...range(start, end + 1));
    }
  };

  weeks.slice(1).forEach((next) => {
    if (next - end === 1) {
      // Consecutive week number - keep going
      end = next;
    } else {
      // Break = push the current chunk into processed
      mergeConsecutive();
      start = next;
      end = start;
    }
  });

  mergeConsecutive();

  return `Weeks ${processed.join(', ')}`;
}

/**
 * Converts a timetable config to query string
 * eg: {
 *      CS2104: { Lecture: '1', Tutorial: '2' },
 *      CS2107: { Lecture: '1', Tutorial: '8' },
 * }
 * => CS2104=LEC:1,Tut:2&CS2107=LEC:1,Tut:8
 * @param serialized
 * @returns
 */
export function serializeTimetable(timetable: SemTimetableConfig): string {
  // We are using query string safe characters, so this encoding is unnecessary
  return qs.stringify(mapValues(timetable, serializeModuleConfig));
}

export function deserializeTimetable(serialized: string): SemTimetableConfig {
  const params = qs.parse(serialized) as Record<
    string,
    string | string[] | null
  >;
  return mapValues(params, parseModuleConfig);
}

export function isSameTimetableConfig(
  t1: SemTimetableConfig,
  t2: SemTimetableConfig
): boolean {
  return isEqual(t1, t2);
}

export function isSameLesson(l1: Lesson, l2: Lesson) {
  return (
    l1.lessonType === l2.lessonType &&
    l1.classNo === l2.classNo &&
    l1.moduleCode === l2.moduleCode &&
    l1.startTime === l2.startTime &&
    l1.endTime === l2.endTime &&
    l1.day === l2.day &&
    isEqual(l1.weeks, l2.weeks)
  );
}

export function getHoverLesson(lesson: Lesson): HoverLesson {
  return {
    classNo: lesson.classNo,
    moduleCode: lesson.moduleCode,
    lessonType: lesson.lessonType,
  };
}

/**
 * Obtain a semi-unique key for a lesson
 */
export function getLessonIdentifier(lesson: Lesson): string {
  return `${lesson.moduleCode}-${LESSON_TYPE_ABBREV[lesson.lessonType]}-${
    lesson.classNo
  }`;
}
