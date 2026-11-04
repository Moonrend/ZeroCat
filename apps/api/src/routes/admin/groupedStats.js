// Split a joint groupBy into the existing single-field statistics response.
export function summarizeGroups(rows, fields) {
    const groups = fields.map(() => new Map());
    let total = 0;
    for (const row of rows) {
        total += row._count;
        for (let index = 0; index < fields.length; index++) {
            const value = row[fields[index]];
            groups[index].set(value, (groups[index].get(value) || 0) + row._count);
        }
    }
    return {
        total,
        groups: groups.map((group, index) => Array.from(group, ([value, count]) => ({
            [fields[index]]: value,
            _count: count,
        }))),
    };
}
