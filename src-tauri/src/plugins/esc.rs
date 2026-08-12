//! Shell escaping for variable interpolation.
//!
//! Plugin variable values are NEVER spliced into a command string raw — that
//! would be command injection. Every value is wrapped following the shell
//! quoting rules of the target OS. Two dedicated escapers exist because POSIX
//! and Windows (cmd.exe) quote differently; there is deliberately no shared
//! "string replace" path.

use super::os::OsFamily;

/// Single-quote a POSIX shell argument. Literal `'` becomes `'\''`, which is
/// the safe-write form: `'>` sequence + escaped quote + reopen. Empty strings
/// become the explicit empty argument `''` rather than nothing.
pub fn posix_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Double-quote a cmd.exe argument (best-effort).
///
/// cmd.exe quoting is famously inconsistent: inside double quotes `& | < > ^`
/// are treated literally, which is the injection surface we must close, but
/// `%VAR%` still expands even inside quotes (interactive cmd has no escape for
/// that) and embedded quotes are escaped by doubling. We accept that
/// limitation, document it, and always wrap — so `|`, `&`, `>`, `<`, `^` can
/// never escape. Plugin authors who need a literal `%` on Windows should use a
/// double `%%` in the template line itself.
pub fn cmd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Quote `value` for the given target family. Everything that is not Windows
/// uses the POSIX escaper (also covers macOS / FreeBSD).
pub fn escape_for(os: OsFamily, value: &str) -> String {
    match os {
        OsFamily::Windows => cmd_quote(value),
        _ => posix_quote(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quotes_plain_values() {
        assert_eq!(posix_quote("hello"), "'hello'");
        assert_eq!(posix_quote(""), "''");
        assert_eq!(posix_quote("a b"), "'a b'");
    }

    #[test]
    fn posix_escapes_embedded_single_quotes() {
        // `'` -> `'\''`: close, escaped quote, reopen.
        assert_eq!(posix_quote("it's"), "'it'\\''s'");
        assert_eq!(posix_quote("'; rm -rf /"), "''\\''; rm -rf /'");
    }

    #[test]
    fn cmd_quotes_special_chars() {
        // These must never close the quote / chain a command: the whole value
        // is inside double quotes, so `& | < > ^` are literal characters.
        let v = cmd_quote("x | y & z > w");
        assert_eq!(v, "\"x | y & z > w\"");
        // No closing quote is allowed before the pipe / ampersand.
        assert!(!v.contains("\" |"));
        assert!(!v.contains("\" &"));
    }

    #[test]
    fn cmd_doubles_embedded_quotes() {
        assert_eq!(cmd_quote("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn escape_for_splits_by_os() {
        assert_eq!(escape_for(OsFamily::Debian, "a"), "'a'");
        assert_eq!(escape_for(OsFamily::Macos, "a"), "'a'");
        assert_eq!(escape_for(OsFamily::Windows, "a"), "\"a\"");
    }
}