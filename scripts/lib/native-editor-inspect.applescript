on run argv
  if (count of argv) is not 1 then error "Exact temporary bundle identifier required"
  set fixtureId to item 1 of argv
  if fixtureId does not start with "dev.atools.fixture.dialog." then error "Temporary ATools application only"
  if (length of fixtureId) is not 58 then error "Invalid temporary application identifier"
  with timeout of 4 seconds
    tell application "System Events"
      set candidates to application processes whose bundle identifier is fixtureId
      if (count of candidates) is not 1 then error "One live temporary application required"
      set fixtureProcess to item 1 of candidates
      tell fixtureProcess
        if (count of windows) is not 1 then error "One temporary window required"
        set fixtureWindow to front window
        set windowPosition to position of fixtureWindow
        set windowSize to size of fixtureWindow
        set linesOut to {"PID|" & (unix id of fixtureProcess), "WINDOW|owned-fixed-window|" & (item 1 of windowPosition) & "," & (item 2 of windowPosition) & "|" & (item 1 of windowSize) & "," & (item 2 of windowSize)}
        set nodes to {fixtureWindow}
        set nodeIndex to 0
        repeat while nodeIndex < (count of nodes) and nodeIndex < 80
          set nodeIndex to nodeIndex + 1
          set nodeRef to item nodeIndex of nodes
          try
            set nodeRole to role of nodeRef
            set nodeName to ""
            if nodeRole is "AXButton" then
              try
                if (name of nodeRef as text) starts with "重新格式化" then set nodeName to "重新格式化"
              end try
            end if
            set nodePosition to position of nodeRef
            set nodeSize to size of nodeRef
            set end of linesOut to (nodeIndex as text) & "|" & nodeRole & "|" & nodeName & "|" & (item 1 of nodePosition) & "," & (item 2 of nodePosition) & "|" & (item 1 of nodeSize) & "," & (item 2 of nodeSize)
          end try
          try
            set childCount to count of UI elements of nodeRef
            set availableSlots to 80 - (count of nodes)
            if childCount > availableSlots then set childCount to availableSlots
            repeat with childIndex from 1 to childCount
              set end of nodes to UI element childIndex of nodeRef
            end repeat
          end try
        end repeat
        set AppleScript's text item delimiters to linefeed
        return linesOut as text
      end tell
    end tell
  end timeout
end run
