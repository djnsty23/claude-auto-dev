<#
.SYNOPSIS
    Quick resume for Claude Code sessions
.EXAMPLE
    cr              # Resume latest / open picker
    cr feature      # Resume session matching "feature"
    cr abc123       # Resume specific session ID
#>

param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$SearchTerm
)

$args = @("-p", "--resume")
if ($SearchTerm) {
    $args += $SearchTerm -join " "
}

& claude @args
