use super::*;

#[test]
#[ignore = "explicit private macOS kernel resource and cleared environment gate"]
fn file_fd_limits_and_environment_clear_are_actual_child_boundaries() {
    let tools = tools();
    let script = r#"import fs from 'node:fs';
        if(process.env.ATOOLS_SOURCE_BUILD_TEST_NODE!==undefined || process.env.NODE_OPTIONS!==undefined || process.env.PATH!=='')process.exit(31);
        const fds=[];let blocked=false;
        for(let i=0;i<2300;i++){try{fds.push(fs.openSync('fd-'+i,'w'));}catch(e){if(e.code!=='EMFILE')throw e;blocked=true;break;}}
        if(!blocked)process.exit(32);
        if(fds.length<=1800 || fds.length>=2048 || fds.some(fd=>fd>=2048))process.exit(33);
        for(const fd of fds)fs.closeSync(fd);
        const fd=fs.openSync('large','w'); const block=Buffer.alloc(1024*1024);
        try{for(let i=0;i<40;i++)fs.writeSync(fd,block);}catch(e){if(e.code!=='EFBIG')throw e;}
        fs.closeSync(fd);
    "#;
    let (workspace, outcome) = run_script(
        &tools,
        script,
        &AtomicBool::new(false),
        supervisor::Limits::default(),
    );
    assert!(outcome.cleanup_confirmed);
    let length = fs::metadata(workspace.root.join("work/large"))
        .unwrap()
        .len();
    assert_eq!(length, 32 * 1024 * 1024);
    let files = fs::read_dir(workspace.root.join("work"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("fd-"))
        .count();
    assert!(files > 1800 && files < 2048);
}
