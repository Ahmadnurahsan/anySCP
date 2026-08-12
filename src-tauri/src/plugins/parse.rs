//! Output parsing + rendering for plugin commands.
//!
//! Two stages:
//! 1. [`parse_stdout`] turns raw stdout into a typed [`Parsed`] using the
//!    command's declared `parser`.
//! 2. [`render`] maps [`Parsed`] onto the declared `output` widget the
//!    frontend will draw (text / table / metrics / json).
//!
//! This is the piece that lets a data-only plugin render as a control-panel
//! widget without any new frontend code.

use serde_json::Value;

use super::manifest::{OutputKind, Parser, ParserType};
use super::{Metric, PluginError, PluginRunResult, PluginTable};

#[derive(Debug, Clone)]
pub enum Parsed {
    Raw(String),
    Rows {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    #[allow(dead_code)] // reachable via render's match arms (future parsers may build it)
    Metrics(Vec<Metric>),
    Json(Value),
}

/// Parse raw stdout according to the command's declared parser.
pub fn parse_stdout(stdout: &str, parser: &Parser) -> Result<Parsed, PluginError> {
    match parser.r#type {
        ParserType::Raw => Ok(Parsed::Raw(stdout.trim_end().to_string())),
        ParserType::Lines => {
            let rows: Vec<Vec<String>> = stdout
                .lines()
                .map(str::trim_end)
                .filter(|l| !l.is_empty())
                .map(|l| vec![l.to_string()])
                .collect();
            Ok(Parsed::Rows {
                columns: Vec::new(),
                rows,
            })
        }
        ParserType::KeyValue => {
            let separator = parser.separator.clone().unwrap_or_else(|| ":".to_string());
            let mut rows = Vec::new();
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match line.find(&separator) {
                    Some(idx) => rows.push(vec![
                        line[..idx].trim().to_string(),
                        line[idx + separator.len()..].trim().to_string(),
                    ]),
                    None => rows.push(vec![line.to_string(), String::new()]),
                }
            }
            Ok(Parsed::Rows {
                columns: vec!["Key".to_string(), "Value".to_string()],
                rows,
            })
        }
        ParserType::RegexTable => {
            let pattern = parser
                .pattern
                .as_deref()
                .ok_or_else(|| PluginError::ParseError("regex_table requires 'pattern'".into()))?;
            let re = regex::Regex::new(pattern)
                .map_err(|e| PluginError::ParseError(format!("invalid pattern: {e}")))?;
            let columns: Vec<String> = re.capture_names().flatten().map(str::to_string).collect();
            let mut rows = Vec::new();
            for line in stdout.lines() {
                if let Some(caps) = re.captures(line) {
                    let row = columns
                        .iter()
                        .map(|c| {
                            caps.name(c)
                                .map(|m| m.as_str().trim().to_string())
                                .unwrap_or_default()
                        })
                        .collect();
                    rows.push(row);
                }
            }
            Ok(Parsed::Rows { columns, rows })
        }
        ParserType::Csv => {
            let mut rows = Vec::new();
            for line in stdout.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                rows.push(split_csv_line(line));
            }
            Ok(Parsed::Rows {
                columns: Vec::new(),
                rows,
            })
        }
        ParserType::Json => {
            let parsed: Value = serde_json::from_str(stdout)
                .map_err(|e| PluginError::ParseError(format!("invalid JSON output: {e}")))?;
            Ok(Parsed::Json(parsed))
        }
    }
}

/// Map a parsed result onto the command's declared output widget.
#[allow(clippy::too_many_arguments)] // render carries the full run context
pub fn render(
    parsed: Parsed,
    output: OutputKind,
    declared_columns: &[String],
    exit_code: i32,
    stderr: String,
    truncated: bool,
    cached: bool,
    os: String,
) -> PluginRunResult {
    let mut result = PluginRunResult {
        output,
        text: None,
        table: None,
        metrics: None,
        json: None,
        exit_code,
        stderr,
        truncated,
        cached,
        os,
        error: None,
    };

    match output {
        OutputKind::Text => {
            let text = match parsed {
                Parsed::Raw(t) => t,
                Parsed::Rows { rows, .. } => rows
                    .iter()
                    .map(|r| r.join("\t"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                Parsed::Metrics(metrics) => metrics
                    .iter()
                    .map(|m| {
                        let unit = m.unit.as_deref().unwrap_or("");
                        format!("{}: {}{}", m.label, m.value, unit)
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                Parsed::Json(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
            };
            result.text = Some(text);
        }
        OutputKind::Table => {
            let (columns, rows) = table_from(parsed, declared_columns);
            result.table = Some(PluginTable { columns, rows });
        }
        OutputKind::Metrics => {
            result.metrics = Some(metrics_from(parsed));
        }
        OutputKind::Json => match parsed {
            Parsed::Json(v) => result.json = Some(v),
            Parsed::Raw(t) => result.json = Some(Value::String(t)),
            Parsed::Rows { columns, rows } => {
                result.json = Some(serde_json::json!({ "columns": columns, "rows": rows }))
            }
            Parsed::Metrics(m) => {
                result.json = Some(serde_json::json!({ "metrics": m }))
            }
        },
    }

    result
}

fn table_from(parsed: Parsed, declared: &[String]) -> (Vec<String>, Vec<Vec<String>>) {
    match parsed {
        Parsed::Rows { columns, rows } => {
            if columns.is_empty() {
                (declared.to_vec(), rows)
            } else {
                (columns, rows)
            }
        }
        Parsed::Metrics(metrics) => (
            vec!["Label".into(), "Value".into(), "Unit".into()],
            metrics
                .into_iter()
                .map(|m| vec![m.label, m.value.to_string(), m.unit.unwrap_or_default()])
                .collect(),
        ),
        Parsed::Json(Value::Array(items)) => rows_from_json_array(items, declared),
        Parsed::Json(Value::Object(map)) => {
            let rows: Vec<Vec<String>> = map
                .iter()
                .map(|(k, v)| vec![k.clone(), json_scalar(v)])
                .collect();
            (vec!["Key".into(), "Value".into()], rows)
        }
        Parsed::Json(other) => (declared.to_vec(), vec![vec![json_scalar(&other)]]),
        Parsed::Raw(t) => (
            declared.to_vec(),
            t.lines()
                .map(|l| vec![l.trim_end().to_string()])
                .filter(|r| !r[0].is_empty())
                .collect(),
        ),
    }
}

fn rows_from_json_array(items: Vec<Value>, declared: &[String]) -> (Vec<String>, Vec<Vec<String>>) {
    let objs: Vec<&Value> = items.iter().filter(|v| v.is_object()).collect();
    let columns: Vec<String> = if objs.is_empty() {
        declared.to_vec()
    } else {
        let mut cols: Vec<String> = Vec::new();
        for o in &objs {
            if let Some(obj) = o.as_object() {
                for k in obj.keys() {
                    if !cols.contains(k) {
                        cols.push(k.clone());
                    }
                }
            }
        }
        cols
    };
    if columns.is_empty() {
        // Not objects — fall back to scalars.
        let rows = items.iter().map(|v| vec![json_scalar(v)]).collect();
        (declared.to_vec(), rows)
    } else {
        let rows = objs
            .iter()
            .map(|o| {
                let obj = o.as_object().expect("filtered is_object");
                columns
                    .iter()
                    .map(|c| obj.get(c).map(json_scalar).unwrap_or_default())
                    .collect()
            })
            .collect();
        (columns, rows)
    }
}

fn metrics_from(parsed: Parsed) -> Vec<Metric> {
    match parsed {
        Parsed::Metrics(metrics) => metrics,
        Parsed::Rows { rows, .. } => rows
            .into_iter()
            .filter_map(|row| {
                let label = row.first().cloned().unwrap_or_default();
                let raw_value = row.get(1).cloned().unwrap_or_default();
                raw_value.parse::<f64>().ok().map(|value| Metric {
                    label,
                    value,
                    unit: None,
                })
            })
            .collect(),
        Parsed::Json(Value::Object(map)) => map
            .iter()
            .filter_map(|(label, v)| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                    .map(|value| Metric {
                        label: label.clone(),
                        value,
                        unit: None,
                    })
            })
            .collect(),
        Parsed::Json(Value::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(i, v)| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                    .map(|value| Metric {
                        label: format!("item_{i}"),
                        value,
                        unit: None,
                    })
            })
            .collect(),
        Parsed::Raw(t) => t
            .lines()
            .filter_map(|line| {
                let mut it = line.splitn(2, ':');
                let label = it.next().unwrap_or_default().trim().to_string();
                let raw = it.next().unwrap_or_default().trim();
                let cleaned: String = raw
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.' || *c == 'e' || *c == 'E')
                    .collect();
                cleaned.parse::<f64>().ok().map(|value| Metric {
                    label,
                    value,
                    unit: None,
                })
            })
            .collect(),
        Parsed::Json(_) => Vec::new(),
    }
}

fn json_scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Minimal CSV splitter: handles quoted fields with embedded commas/escaped
/// double quotes. Good enough for `ps`, `df`, `systemctl`-style table output.
fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut it = line.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '"' => {
                if in_quotes && it.peek() == Some(&'"') {
                    cur.push('"');
                    it.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' => {
                if in_quotes {
                    cur.push(c);
                } else {
                    fields.push(cur.trim().to_string());
                    cur = String::new();
                }
            }
            _ => cur.push(c),
        }
    }
    fields.push(cur.trim().to_string());
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser(t: ParserType) -> Parser {
        Parser {
            r#type: t,
            separator: None,
            pattern: None,
        }
    }

    #[test]
    fn raw_passthrough() {
        let p = parse_stdout("hello\nworld\n", &parser(ParserType::Raw)).unwrap();
        assert!(matches!(p, Parsed::Raw(_)));
        let r = render(p, OutputKind::Text, &[], 0, String::new(), false, false, "linux".into());
        assert_eq!(r.text.as_deref(), Some("hello\nworld"));
    }

    #[test]
    fn key_value_uses_declared_separator() {
        let mut p = Parser::default();
        p.r#type = ParserType::KeyValue;
        p.separator = Some("=".into());
        let parsed = parse_stdout("user = root\nhost=web1\nbare\n", &p).unwrap();
        let Parsed::Rows { columns, rows } = parsed else { panic!() };
        assert_eq!(columns, vec!["Key", "Value"]);
        assert_eq!(rows[0], vec!["user", "root"]);
        assert_eq!(rows[1], vec!["host", "web1"]);
        assert_eq!(rows[2], vec!["bare", ""]);
    }

    #[test]
    fn regex_table_extracts_named_groups() {
        let mut p = Parser::default();
        p.r#type = ParserType::RegexTable;
        p.pattern = Some("^(?P<user>\\S+)\\s+(?P<cpu>\\d+)%.*$".into());
        let parsed =
            parse_stdout("root 5% /bin/bash\nwww   2% nginx\nnot-a-match\n", &p).unwrap();
        let Parsed::Rows { columns, rows } = parsed else { panic!() };
        assert_eq!(columns, vec!["user", "cpu"]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["root", "5"]);
        assert_eq!(rows[1], vec!["www", "2"]);
    }

    #[test]
    fn csv_splits_quoted_fields() {
        let fields = split_csv_line("\"/usr/lib/x,5\",100%,/mnt");
        assert_eq!(fields, vec!["/usr/lib/x,5", "100%", "/mnt"]);
    }

    #[test]
    fn json_parser_and_json_widget() {
        let p = parse_stdout(r#"{"version":"8.0","running":true}"#, &parser(ParserType::Json)).unwrap();
        let r = render(p, OutputKind::Json, &[], 0, String::new(), false, false, "linux".into());
        assert_eq!(r.json.as_ref().unwrap()["version"], "8.0");
    }

    #[test]
    fn metrics_from_key_value_rows() {
        let p = parse_stdout("Cpu: 12.5\nMem: 2048\nUp: 4 days\n", &parser(ParserType::KeyValue)).unwrap();
        let r = render(p, OutputKind::Metrics, &[], 0, String::new(), false, false, "linux".into());
        let metrics = r.metrics.unwrap();
        assert_eq!(metrics.len(), 2); // "Up: 4 days" is not float-parseable
        assert_eq!(metrics[0].label, "Cpu");
        assert_eq!(metrics[0].value, 12.5);
    }

    #[test]
    fn table_from_json_array_of_objects() {
        let p = parse_stdout(
            r#"[{"name":"web","status":"running"},{"name":"db","status":"exited"}]"#,
            &parser(ParserType::Json),
        )
        .unwrap();
        let r = render(p, OutputKind::Table, &[], 0, String::new(), false, false, "linux".into());
        let table = r.table.unwrap();
        assert_eq!(table.columns, vec!["name", "status"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[1], vec!["db", "exited"]);
    }
}