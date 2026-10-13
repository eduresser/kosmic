/*
    KOSMIC: the active hint, drawn where cosmic-comp draws it.
    SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>

    SPDX-License-Identifier: GPL-3.0-only
*/

#include "outline.h"

#include <KPluginFactory>

namespace KWin
{

class KWIN_EXPORT OutlineFactory : public PluginFactory
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "metadata.json")
    Q_INTERFACES(KWin::PluginFactory)

public:
    explicit OutlineFactory() = default;

    std::unique_ptr<Plugin> create() const override
    {
        return std::make_unique<Outline>();
    }
};

} // namespace KWin

#include "main.moc"
