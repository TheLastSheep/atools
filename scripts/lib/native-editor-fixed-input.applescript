on rejectGuard(guardCode, dispatchStage)
  if dispatchStage is not in {"before-click", "after-click", "before-select-all", "before-character", "before-linebreak"} then set dispatchStage to "unknown"
  error "Fixed action rejected: guard=" & guardCode & ";dispatchStage=" & dispatchStage number -2700
end rejectGuard

on assertOwnedPID(actualPid, expectedPid, dispatchStage)
  if actualPid is not expectedPid then my rejectGuard("pid-mismatch", dispatchStage)
end assertOwnedPID

on assertOwnedWindowState(windowIsOne, isFrontmost, dispatchStage)
  if not windowIsOne then my rejectGuard("window-count", dispatchStage)
  if not isFrontmost then my rejectGuard("not-frontmost", dispatchStage)
end assertOwnedWindowState

on assertOwnedFocus(fixtureId, expectedPid, dispatchStage)
  tell application "System Events"
    set candidates to application processes whose bundle identifier is fixtureId
    if (count of candidates) is not 1 then my rejectGuard("candidate-count", dispatchStage)
    set fixtureProcess to item 1 of candidates
    my assertOwnedPID((unix id of fixtureProcess), expectedPid, dispatchStage)
    if not (frontmost of fixtureProcess) then my rejectGuard("not-frontmost", dispatchStage)
  end tell
end assertOwnedFocus

on run argv
  if (count of argv) is not 6 then error "Exact temporary app, PID, fixed operation, observed point and fixed stage required"
  set fixtureId to item 1 of argv
  if fixtureId does not start with "dev.atools.fixture.dialog." or (length of fixtureId) is not 58 then error "Temporary ATools application only"
  set expectedPid to item 2 of argv as integer
  if expectedPid < 2 then error "Live target PID required"
  set operation to item 3 of argv
  set actionStage to item 6 of argv
  if actionStage is not in {"click", "type"} then error "Unreviewed dispatch stage rejected"
  if operation is "plain-alpha" then
    set fixedLines to {"ATools plain alpha document line 1234567890", "Alpha fixed body", "Second line."}
  else if operation is "plain-beta" then
    set fixedLines to {"# ATools markdown beta document", "", "- first", "- second"}
  else if operation is "json-valid" or operation is "json-recovery" then
    set fixedLines to {"{\"name\":\"ATools\",\"nested\":{\"active\":true,\"items\":[1,2]}}"}
  else if operation is "json-malformed" then
    set fixedLines to {"{\"name\":\"ATools\",\"nested\":[1,]}"}
  else if operation is "json-format" then
    set fixedLines to {}
  else
    error "Unreviewed operation rejected"
  end if
  if operation is "json-format" and actionStage is "type" then error "Format is click only"
  set pointX to item 4 of argv as integer
  set pointY to item 5 of argv as integer
  with timeout of 4 seconds
    tell application "System Events"
      set candidates to application processes whose bundle identifier is fixtureId
      if (count of candidates) is not 1 then my rejectGuard("candidate-count", "before-click")
      tell item 1 of candidates
        my assertOwnedPID((unix id), expectedPid, "before-click")
        set windowIsOne to (count of windows) is 1
        set isFrontmost to frontmost
        my assertOwnedWindowState(windowIsOne, isFrontmost, "before-click")
        set windowPosition to position of front window
        set windowSize to size of front window
        if pointX < (item 1 of windowPosition) + 10 or pointX > (item 1 of windowPosition) + (item 1 of windowSize) - 10 then my rejectGuard("point-outside-x", "before-click")
        if pointY < (item 2 of windowPosition) + 40 or pointY > (item 2 of windowPosition) + (item 2 of windowSize) - 10 then my rejectGuard("point-outside-y", "before-click")
        my assertOwnedFocus(fixtureId, expectedPid, "before-click")
        if actionStage is "click" then
          log "stage:click-start"
          click at {pointX, pointY}
          my assertOwnedFocus(fixtureId, expectedPid, "after-click")
          log "stage:click-completed"
        else
          my assertOwnedFocus(fixtureId, expectedPid, "before-select-all")
          log "stage:select-all-start"
          keystroke "a" using command down
          log "stage:select-all-completed"
          log "stage:fixed-typing-start"
          repeat with lineIndex from 1 to count of fixedLines
            repeat with fixedCharacter in characters of (item lineIndex of fixedLines)
              my assertOwnedFocus(fixtureId, expectedPid, "before-character")
              keystroke (fixedCharacter as text)
            end repeat
            if lineIndex < (count of fixedLines) then
              my assertOwnedFocus(fixtureId, expectedPid, "before-linebreak")
              key code 36 using shift down
            end if
          end repeat
          log "stage:fixed-typing-completed"
        end if
        return "Fixed action dispatched: " & operation & ":" & actionStage
      end tell
    end tell
  end timeout
end run
