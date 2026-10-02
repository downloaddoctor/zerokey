const TEST_TEMPLATE = `Testing all basic tools...

⟦todos_add¦id=1¦title=Execute todos_add command¦desc=Add Task One and Task Two
¦id=2¦title=Execute todos_set command¦desc=Set Task 1 status to done
¦id=3¦title=Execute write command¦desc=Write temp.txt (Hello)
¦id=4¦title=Execute read command (1st)¦desc=Read temp.txt after write
¦id=5¦title=Execute replace command¦desc=Replace Hello with Hello Code in temp.txt
¦id=6¦title=Execute read command (2nd)¦desc=Read temp.txt to verify expected Hello Code result
¦id=7¦title=Execute ls command (1st)¦desc=List current directory
¦id=8¦title=Execute glob command¦desc=Search **/*.js max 10
¦id=9¦title=Execute grep command¦desc=Search Router in *.js max 5
¦id=10¦title=Execute cmd echo test¦desc=Run 'echo test'
¦id=11¦title=Execute cmd delete file¦desc=Delete _test_tool.txt
¦id=12¦title=Execute mkdir command¦desc=Create _test_dir
¦id=13¦title=Execute ls command (2nd)¦desc=List directory after mkdir
¦id=14¦title=Execute cmd_bg command¦desc=Run ping -n 5 127.0.0.1 in background
¦id=15¦title=Execute fetch command¦desc=Fetch JSONPlaceholder todo/1
¦id=16¦title=Execute view_image command¦desc=View docs/logos/terax.png
¦id=17¦title=Execute final echo command¦desc=Display "above all where testing..."⟧

⟦todos_set¦id=1¦status=done⟧
Escaping test - \`⟦todos_set¦id=2¦status=done⟧\`
⟦todos_set¦id=2¦status=done⟧

⟦todos_set¦id=3¦status=active⟧
⟦write¦path=#{cwd}#\\temp\\_test.txt¦content=Hello!⟧
⟦todos_set¦id=3¦status=done⟧

⟦todos_set¦id=4¦status=active⟧
⟦read¦path=#{cwd}#\\temp\\temp.txt⟧
⟦todos_set¦id=4¦status=done⟧

⟦todos_set¦id=5¦status=active⟧
⟦replace¦path=#{cwd}#\\temp\\temp.txt¦old=Hello¦new=Hello Code⟧
⟦todos_set¦id=5¦status=done⟧

⟦todos_set¦id=6¦status=active⟧
⟦read¦path=#{cwd}#\\temp\\tempR.txt⟧
⟦todos_set¦id=6¦status=done⟧

⟦todos_set¦id=7¦status=active⟧
⟦ls¦path=#{cwd}#⟧
⟦todos_set¦id=7¦status=done⟧

⟦todos_set¦id=8¦status=active⟧
⟦glob¦pattern=**/*.js¦max=5⟧
⟦todos_set¦id=8¦status=done⟧

⟦todos_set¦id=9¦status=active⟧
⟦grep¦query=Router¦filter=*.js¦max=5⟧
⟦todos_set¦id=9¦status=done⟧

⟦todos_set¦id=10¦status=active⟧
⟦cmd¦run=echo test⟧
⟦todos_set¦id=10¦status=done⟧

⟦todos_set¦id=11¦status=active⟧
⟦cmd¦run=del #{cwd}#\\temp\\_test.txt⟧
⟦todos_set¦id=11¦status=done⟧

⟦todos_set¦id=12¦status=active⟧
⟦mkdir¦path=#{cwd}#\\temp\\_test_dir⟧
⟦todos_set¦id=12¦status=done⟧

⟦todos_set¦id=13¦status=active⟧
⟦ls¦path=#{cwd}#\\temp⟧
⟦todos_set¦id=13¦status=done⟧

⟦todos_set¦id=14¦status=active⟧
⟦cmd_bg¦run=ping -n 5 127.0.0.1⟧
⟦todos_set¦id=14¦status=done⟧

⟦todos_set¦id=15¦status=active⟧
⟦fetch¦url=https://jsonplaceholder.typicode.com/todos/1⟧
⟦todos_set¦id=15¦status=done⟧

⟦todos_set¦id=16¦status=active⟧
⟦view_image¦path=#{cwd}#\\docs\\logos\\terax.png⟧
⟦todos_set¦id=16¦status=done⟧

⟦todos_set¦id=17¦status=active⟧
⟦ask¦question=All tools called, are they working?¦option=Yes¦option=No¦option=Something else⟧
⟦todos_set¦id=17¦status=done⟧

⟦cmd¦run=echo "ABOVE ALL WHERE TESTING CALLS OF:
Execute todos_add command => Add Task One and Task Two
Execute todos_set command => Set Task 1 status to done
Execute write command => Write temp.txt (Hello)
Execute read command (1st) => Read temp.txt after write
Execute replace command => Replace Hello with Hello Code in temp.txt
Execute read command (2nd) => Read temp.txt to verify expected Hello Code result
Execute ls command (1st) => List current directory
Execute glob command => Search **/*.js max 5
Execute grep command => Search Router in *.js max 5
Execute cmd echo test => Run 'echo test'
Execute cmd delete file => Delete _test_tool.txt
Execute mkdir command => Create _test_dir
Execute ls command (2nd) => List directory after mkdir
Execute cmd_bg command => Run ping -n 5 127.0.0.1 in background
Execute fetch command => Fetch JSONPlaceholder todo/1
Execute view_image command => View docs/logos/terax.png
Execute final echo command => Display above all where testing...

SO DO ANALYSIS OF IT AND GIVE USER SUMMARY WHICH WORKS WHICH NOT WORKS
-----------------------"⟧
