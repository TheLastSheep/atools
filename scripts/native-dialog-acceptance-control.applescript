-- Only the four explicitly authorized operations in the isolated fixture PID.
on fixturePanel(targetProcess)
    tell application "System Events"
        tell targetProcess
            repeat with candidate in windows
                if (count of sheets of candidate) > 0 then return sheet 1 of candidate
                if name of candidate is "选择文件夹" or name of candidate is "保存目录树图片" then return candidate
            end repeat
        end tell
    end tell
    error "The isolated fixture has no native picker panel"
end fixturePanel

on fixtureElements(panel)
    tell application "System Events" to set panelElements to entire contents of panel
    if (count of panelElements) > 512 then error "Native picker accessibility budget exceeded"
    return panelElements
end fixtureElements

on fixtureButton(panel, labels)
    set matchedButtons to {}
    tell application "System Events"
        repeat with element_ in my fixtureElements(panel)
            if role of element_ is "AXButton" then
                if name of element_ is in labels then set end of matchedButtons to contents of element_
            end if
        end repeat
    end tell
    if (count of matchedButtons) is not 1 then error "Exactly one reviewed native button is required"
    set targetButton to item 1 of matchedButtons
    tell application "System Events"
        if enabled of targetButton is not true then error "Reviewed native button is disabled"
    end tell
    return targetButton
end fixtureButton

on navigatePrivateDirectory(targetProcess, panel, targetDirectory)
    tell application "System Events"
        tell targetProcess to keystroke "g" using {command down, shift down}
        set navigationPanel to missing value
        repeat 30 times
            if (count of sheets of panel) is 1 then
                set navigationPanel to sheet 1 of panel
                exit repeat
            end if
            delay 0.1
        end repeat
        if navigationPanel is missing value then error "Native Go To sheet did not open"
        set navigationFields to {}
        set navigationElements to entire contents of navigationPanel
        if (count of navigationElements) > 32 then error "Go To sheet accessibility budget exceeded"
        repeat with element_ in navigationElements
            if role of element_ is "AXTextField" then set end of navigationFields to contents of element_
        end repeat
        if (count of navigationFields) is not 1 then error "Exactly one Go To path field is required"
        set targetField to item 1 of navigationFields
        click targetField
        tell targetProcess
            keystroke "a" using command down
            keystroke targetDirectory
        end tell
        -- System Events can return before the field editor receives all keys.
        repeat 30 times
            if value of targetField is targetDirectory then exit repeat
            delay 0.1
        end repeat
        if value of targetField is not targetDirectory then error "Go To path differs from the exact private directory"
        -- The first Return may settle the system's path completion. Only send
        -- another while the same observed private path sheet is still present.
        repeat 2 times
            delay 0.6
            if not (exists navigationPanel) then exit repeat
            if value of targetField is not targetDirectory then error "Private Go To path changed"
            tell targetProcess to key code 36
        end repeat
        repeat 30 times
            if not (exists navigationPanel) then return
            delay 0.1
        end repeat
        error "Native Go To sheet did not finish private directory navigation"
    end tell
end navigatePrivateDirectory

on panelEvidence(panel)
    set buttonLabels to {}
    set fileNameEvidence to ""
    tell application "System Events"
        repeat with element_ in my fixtureElements(panel)
            if role of element_ is "AXButton" then
                if name of element_ is in {"Cancel", "取消", "Open", "打开", "选择", "Choose", "Save", "存储", "保存"} then set end of buttonLabels to name of element_
            else if role of element_ is "AXTextField" then
                if value of element_ is "tree-data@1x.png" then set fileNameEvidence to "reviewed-png-name-present"
            end if
        end repeat
        return {role of panel, buttonLabels, fileNameEvidence}
    end tell
end panelEvidence

on run argv
    if (count of argv) < 2 then error "Fixture PID and action required"
    set targetPid to item 1 of argv as integer
    set operation to item 2 of argv
    if operation is not in {"inspect", "cancel", "goto", "name", "confirm"} then error "Unknown fixture operation"
    tell application "System Events"
        set targetProcess to first application process whose unix id is targetPid
        tell targetProcess to set frontmost to true
    end tell
    set panel to my fixturePanel(targetProcess)
    if operation is "cancel" then
        set targetButton to my fixtureButton(panel, {"Cancel", "取消"})
        tell application "System Events" to click targetButton
        return "actual-native-cancel-button-clicked"
    else if operation is "goto" then
        if (count of argv) is not 3 then error "Private fixture directory required"
        set targetDirectory to item 3 of argv
        if targetDirectory does not start with "/private/tmp/atools-fixture-environment-" then error "Only the private fixture directory is allowed"
        if targetDirectory does not end with "/native-fixture/tree-data" and targetDirectory does not end with "/native-fixture/export-output" then error "Unexpected private fixture target"
        my navigatePrivateDirectory(targetProcess, panel, targetDirectory)
    else if operation is "name" then
        if (count of argv) is not 3 or item 3 of argv is not "tree-data@1x.png" then error "Only the reviewed fixture PNG name is allowed"
        set matchedFields to {}
        tell application "System Events"
            repeat with element_ in my fixtureElements(panel)
                if role of element_ is "AXTextField" then
                    if value of element_ is item 3 of argv then set end of matchedFields to contents of element_
                end if
            end repeat
            if (count of matchedFields) is not 1 then error "Exactly one existing reviewed PNG filename field is required"
            set targetField to item 1 of matchedFields
            set value of targetField to item 3 of argv
        end tell
    else if operation is "confirm" then
        set targetButton to my fixtureButton(panel, {"Open", "打开", "选择", "Choose", "Save", "存储", "保存"})
        tell application "System Events" to click targetButton
        return "actual-native-confirm-button-clicked"
    end if
    return my panelEvidence(my fixturePanel(targetProcess))
end run
