sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    ' A <Label> with an unknown font name used to CRASH the simulator here, at scene
    ' construction (Label.setValue -> getMeasured -> drawText -> font.createDrawFont is not
    ' a function), while a real Roku device renders the label as nothing and keeps running.
    ' This asserts the simulator now matches the device: the scene builds and does not crash.
    scene = screen.CreateScene("BadFontScene")
    if scene <> invalid then print "scene created"
    print "no crash"
end sub
